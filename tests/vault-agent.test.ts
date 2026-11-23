import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore, NewerVersionError } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import type { AgentConfig, HostInput } from '../src/shared/types'

const createVault = () => new Vault(emptyStore(), new MemorySecretCodec())
const input: HostInput = { groupId: null, name: 'agent', host: 'example.test', port: 22, username: 'hop', authType: 'agent' }
const agent: AgentConfig = { socket: '~/Library/Agent/socket', identityFile: '~/.ssh/key.pub', forward: true }
let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-vault-agent-')) })
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })

describe('v3 agent storage and portability', () => {
  it('migrates v2 without changing any other fields or mutating its source', () => {
    const vault = createVault()
    const group = vault.saveGroup({ name: 'group' })
    vault.saveHost({ ...input, authType: 'password', groupId: group.id, password: 'secret', meta: { tags: ['tag'] } })
    const snapshot = vault.snapshot()
    const v2 = { ...snapshot, version: 2, hosts: snapshot.hosts.map(({ agent: _agent, jumps, ...host }) => ({ ...host, jump: jumps[0] ?? null })) }
    const before = structuredClone(v2)
    expect(migrateStore(v2)).toEqual({ migratedFrom: 2, data: snapshot })
    expect(v2).toEqual(before)
    const file = path.join(directory, 'vault.json')
    fs.writeFileSync(file, JSON.stringify(v2))
    expect(readStoreFile(file)).toEqual({ data: snapshot, migratedFrom: 2, hadRejectedRecords: false })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(v2)
  })

  it('rejects v10 without touching the original file', () => {
    const file = path.join(directory, 'vault.json')
    const original = JSON.stringify({ version: 10, hosts: [{ future: true }], groups: [] })
    fs.writeFileSync(file, original)
    const before = fs.statSync(file)
    expect(() => readStoreFile(file)).toThrow(NewerVersionError)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs)
    expect(fs.readdirSync(directory)).toEqual(['vault.json'])
  })

  it.each(['merge', 'replace'] as const)('round-trips agent hosts and jumps through disk and portable %s', (mode) => {
    const source = createVault()
    const host = source.saveHost({ ...input, agent, jumps: [{ host: 'jump.test', port: 22, username: 'jump', authType: 'agent' }] })
    const portable = source.exportPortable('fixed')
    expect(portable.version).toBe(8)
    const target = createVault()
    target.importPortable(JSON.parse(JSON.stringify(portable)), mode)
    expect(target.exportPortable('fixed')).toEqual(portable)
    expect(target.listHosts()).toEqual(source.listHosts())
    const file = path.join(directory, 'vault.json')
    fs.writeFileSync(file, JSON.stringify(source.snapshot()))
    expect(readStoreFile(file).data).toEqual(source.snapshot())
    const copy = source.duplicateHost(host.id)
    copy.agent!.socket = 'external mutation'
    expect(source.getHost(copy.id)!.agent).toEqual(agent)
    host.agent!.identityFile = 'external mutation'
    expect(source.getHost(host.id)!.agent).toEqual(agent)
    target.deleteHost(host.id)
    source.importPortable(target.exportPortable(), 'merge')
    expect(source.getHost(host.id)).toBeUndefined()
  })

  it('defaults, preserves omitted settings, clears explicit null, and drops agent config for other auth modes', () => {
    const vault = createVault()
    const host = vault.saveHost(input)
    const defaults = { socket: null, identityFile: null, forward: false }
    expect(host.agent).toEqual(defaults)
    vault.saveHost({ ...input, id: host.id, agent })
    expect(vault.saveHost({ ...input, id: host.id }).agent).toEqual(agent)
    expect(vault.saveHost({ ...input, id: host.id, agent: null }).agent).toEqual(defaults)
    expect(vault.saveHost({ ...input, id: host.id, authType: 'privateKey', agent }).agent).toBeNull()
  })

  it('imports v2 records with null agent while preserving tombstones and assets', () => {
    const source = createVault()
    source.saveHost({ ...input, authType: 'password', meta: { note: 'old' } })
    const deleted = source.saveHost({ ...input, authType: 'password' })
    source.deleteHost(deleted.id)
    const portable = source.exportPortable('fixed')
    const v2 = { ...portable, version: 2, hosts: portable.hosts.map(({ agent: _agent, jumps, ...host }) => ({ ...host, jump: jumps[0] ?? null })) }
    const target = createVault()
    target.importPortable(v2 as never, 'replace')
    expect(target.exportPortable('fixed')).toEqual(portable)
  })

  it.each(['merge', 'replace'] as const)('rejects invalid agent settings atomically in %s', (mode) => {
    const vault = createVault()
    const saved = vault.saveHost({ ...input, agent })
    const before = vault.snapshot()
    const invalid = { ...agent, forward: 'true' } as unknown as AgentConfig
    expect(() => vault.saveHost({ ...input, id: saved.id, name: 'changed', agent: invalid })).toThrow('Agent 配置不正确')
    expect(vault.snapshot()).toEqual(before)
    const portable = vault.exportPortable()
    portable.hosts.push({ ...portable.hosts[0]!, id: 'bad', agent: invalid })
    expect(() => vault.importPortable(portable, mode)).toThrow('Agent 配置不正确')
    expect(vault.snapshot()).toEqual(before)
    expect(() => vault.importPortable({ ...portable, version: 9 } as never, mode)).toThrow('备份来自更新版本')
    expect(vault.snapshot()).toEqual(before)
  })
})
