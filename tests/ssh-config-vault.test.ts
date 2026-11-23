import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import type { AgentConfig, HostInput } from '../src/shared/types'

const create = () => new Vault(emptyStore(), new MemorySecretCodec())
const agent = { socket: '/custom/agent', identityFile: '/keys/selected.pub', forward: true }
const input: HostInput = { name: 'target', host: 'target', port: 22, username: 'user', groupId: null, authType: 'agent',
  jumps: [{ host: 'jump', port: 2200, username: 'jumper', authType: 'agent', agent }] }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-import-v5-'))
afterEach(() => { for (const file of fs.readdirSync(directory)) fs.rmSync(path.join(directory, file), { recursive: true }) })

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

// All fixtures are generated from the current vault, then stripped back to their historical shape.
describe('v5 jump agent storage', () => {
  it('migrates v4 jumps to agent:null without changing the source or other data', () => {
    const vault = create()
    vault.saveHost(input)
    const current = vault.snapshot()
    const legacy = { ...current, version: 4, hosts: current.hosts.map((host) => ({ ...host,
      jumps: host.jumps.map(({ agent: _agent, ...jump }) => jump)
    })) }
    const before = structuredClone(legacy)
    const expected = { ...current, hosts: current.hosts.map((host) => ({ ...host, jumps: host.jumps.map((jump) => ({ ...jump, agent: null })) })) }
    expect(migrateStore(legacy)).toEqual({ data: expected, migratedFrom: 4 })
    expect(legacy).toEqual(before)
    const file = path.join(directory, 'v4.json')
    const bytes = JSON.stringify(legacy)
    fs.writeFileSync(file, bytes)
    expect(readStoreFile(file)).toEqual({ data: expected, migratedFrom: 4, hadRejectedRecords: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
  })

  it.each(['merge', 'replace'] as const)('round-trips jump agents through portable %s, disk, public records and duplication', (mode) => {
    const source = create()
    const saved = source.saveHost(input)
    const expected = { ...agent, forward: false }
    expect(saved.jumps[0].agent).toEqual(expected)
    expect(agent.forward).toBe(true)
    const portable = source.exportPortable('fixed')
    expect(portable.version).toBe(8)
    expect(portable.hosts[0].jumps[0].agent).toEqual(expected)
    const target = create()
    target.importPortable(JSON.parse(JSON.stringify(portable)), mode)
    expect(target.exportPortable('fixed')).toEqual(portable)
    const file = path.join(directory, 'v5.json')
    fs.writeFileSync(file, JSON.stringify(target.snapshot()))
    expect(readStoreFile(file)).toEqual({ data: target.snapshot(), migratedFrom: null, hadRejectedRecords: false })
    saved.jumps[0].agent!.socket = '/mutated'
    const duplicate = source.duplicateHost(saved.id)
    duplicate.jumps[0].agent!.identityFile = '/mutated'
    portable.hosts[0].jumps[0].agent!.socket = '/mutated'
    expect(source.getHost(saved.id)!.jumps[0].agent).toEqual(expected)
    expect(source.getHost(duplicate.id)!.jumps[0].agent).toEqual(expected)
  })

  it.each([1, 2, 3, 4])('imports v%s portable jumps with agent:null', (version) => {
    const source = create()
    source.saveHost(input)
    const exported = source.exportPortable('fixed')
    const legacy = { ...exported, version, hosts: exported.hosts.map(({ jumps, ...host }) => {
      const old = jumps.map(({ agent: _agent, ...jump }) => jump)
      return { ...host, ...(version < 4 ? { jump: old[0] } : { jumps: old }) }
    }) }
    const target = create()
    target.importPortable(legacy as never, 'replace')
    expect(target.listHosts()[0].jumps[0]).toMatchObject({ host: 'jump', port: 2200, username: 'jumper', agent: null })
    expect(target.exportPortable().version).toBe(8)
  })

  it('preserves omitted agent settings only at the same endpoint, clears null and non-agent auth', () => {
    const vault = create()
    const saved = vault.saveHost(input)
    const { agent: _agent, ...jump } = input.jumps![0]
    expect(vault.saveHost({ ...input, id: saved.id, jumps: [jump] }).jumps[0].agent).toEqual({ ...agent, forward: false })
    expect(vault.saveHost({ ...input, id: saved.id, jumps: [{ ...jump, host: 'other' }] }).jumps[0].agent).toBeNull()
    expect(vault.saveHost({ ...input, id: saved.id, jumps: [{ ...jump, agent: null }] }).jumps[0].agent).toBeNull()
    expect(vault.saveHost({ ...input, id: saved.id, jumps: [{ ...jump, authType: 'password', agent }] }).jumps[0].agent).toBeNull()
  })

  it('rejects invalid jump agents atomically and forces forwarding off on disk recovery', () => {
    const vault = create()
    const saved = vault.saveHost(input)
    const before = vault.snapshot()
    const invalid = { ...agent, socket: 42 } as unknown as AgentConfig
    expect(() => vault.saveHost({ ...input, id: saved.id, jumps: [{ ...input.jumps![0], agent: invalid }] })).toThrow('Agent 配置不正确')
    const portable = vault.exportPortable()
    portable.hosts[0].jumps[0].agent = invalid
    expect(() => vault.importPortable(portable, 'replace')).toThrow('Agent 配置不正确')
    expect(vault.snapshot()).toEqual(before)
    before.hosts[0].jumps[0].agent!.forward = true
    const file = path.join(directory, 'forward.json')
    fs.writeFileSync(file, JSON.stringify(before))
    expect(readStoreFile(file).data.hosts[0].jumps[0].agent!.forward).toBe(false)
  })
})
