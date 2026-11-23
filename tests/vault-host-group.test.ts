import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import type { HostInput } from '../src/shared/types'
import { writeJsonFile } from '../src/core/json-file'

const input: HostInput = { groupId: null, name: 'web', host: 'example.test', port: 22, username: 'root', authType: 'agent', newGroupName: ' Production ' }
const createVault = () => new Vault(emptyStore(), new MemorySecretCodec())

describe('atomic host and group save', () => {
  it('creates a group and links the host in a single persistence snapshot', () => {
    const vault = createVault()
    let persisted = 0
    const host = vault.saveHostWithGroup(input, () => {
      persisted++
      const snapshot = vault.snapshot()
      expect(snapshot.hosts).toHaveLength(1)
      expect(snapshot.groups).toHaveLength(1)
      expect(snapshot.hosts[0]!.groupId).toBe(snapshot.groups[0]!.id)
    })
    expect(persisted).toBe(1)
    expect(vault.listGroups()[0]!.name).toBe('Production')
    expect(vault.listGroups()[0]!.id).toBe(host.groupId)
  })

  it('does not leave a group when host validation fails and retry creates exactly one', () => {
    const vault = createVault()
    expect(() => vault.saveHostWithGroup({ ...input, port: 0 })).toThrow()
    expect(vault.listGroups()).toEqual([])
    expect(vault.listHosts()).toEqual([])
    vault.saveHostWithGroup(input)
    expect(vault.listGroups()).toHaveLength(1)
    expect(vault.listHosts()).toHaveLength(1)
  })

  it('rejects empty or duplicate group names without mutating the vault', () => {
    const vault = createVault()
    vault.saveGroup({ name: 'Production' })
    const before = vault.snapshot()
    expect(() => vault.saveHostWithGroup(input)).toThrow('已有同名分组')
    expect(() => vault.saveHostWithGroup({ ...input, newGroupName: '  ' })).toThrow()
    expect(vault.snapshot()).toEqual(before)
  })

  it('restores existing host fields if a later proxy field is invalid', () => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, newGroupName: undefined })
    const before = vault.snapshot()
    expect(() => vault.saveHostWithGroup({ ...input, id: host.id, name: 'changed', proxy: { type: 'socks5', host: 'localhost', port: 0 } })).toThrow()
    expect(vault.snapshot()).toEqual(before)
  })

  it('rolls back both objects on persistence failure and supports retry', () => {
    const vault = createVault()
    const before = vault.snapshot()
    expect(() => vault.saveHostWithGroup(input, () => { throw new Error('disk full') })).toThrow('disk full')
    expect(vault.snapshot()).toEqual(before)
    vault.saveHostWithGroup(input)
    expect(vault.listGroups()).toHaveLength(1)
    expect(vault.listHosts()).toHaveLength(1)
  })

  it.each(['write', 'flush', 'rename'] as const)('keeps disk and memory unchanged when atomic file %s fails', (phase) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-host-save-'))
    const file = path.join(directory, 'store.json')
    const vault = createVault()
    const existing = vault.saveHost({ ...input, newGroupName: undefined })
    const before = vault.snapshot()
    writeJsonFile(file, before)
    const diskBefore = fs.readFileSync(file, 'utf8')
    const failure = Object.assign(new Error('disk write failed'), { code: 'EIO' })
    const spy = phase === 'write'
      ? vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd) => {
        if (typeof fd === 'number') fs.writeSync(fd, '{partial')
        throw failure
      })
      : phase === 'flush' ? vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw failure })
        : vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw failure })
    try {
      const save = () => writeJsonFile(file, vault.snapshot())
      expect(() => vault.saveHostWithGroup({ ...input, id: existing.id, name: 'edited' }, save)).toThrow('disk write failed')
      expect(vault.snapshot()).toEqual(before)
      expect(fs.readFileSync(file, 'utf8')).toBe(diskBefore)
      spy.mockRestore()
      const edited = vault.saveHostWithGroup({ ...input, id: existing.id, name: 'edited' }, save)
      expect(vault.listHosts()).toHaveLength(1)
      expect(vault.listGroups()).toHaveLength(1)
      expect(edited.groupId).toBe(vault.listGroups()[0]!.id)
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(vault.snapshot())
    } finally {
      spy.mockRestore()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
