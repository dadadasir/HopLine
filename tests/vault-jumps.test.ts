import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore, NewerVersionError } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import type { HostInput, JumpInput } from '../src/shared/types'

const input: HostInput = { name: 'target', host: 'target.test', port: 22, username: 'target', groupId: null, authType: 'password' }
const jumps: JumpInput[] = [1, 2].map((index) => ({
  host: `jump${index}.test`, port: 2200 + index, username: `user${index}`, authType: 'privateKey',
  password: `password${index}`, privateKey: `key${index}`, passphrase: `phrase${index}`, privateKeyPath: `/key${index}`
}))
const createVault = () => new Vault(emptyStore(), new MemorySecretCodec())
const omitted = () => jumps.map(({ password: _password, privateKey: _key, passphrase: _phrase, ...jump }) => jump)
let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-jumps-')) })
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })

describe('v4 ordered jumps', () => {
  it.each([2, 3])('migrates v%s with and without a jump, preserving every other field and the original file', (version) => {
    const vault = createVault()
    vault.saveHost({ ...input, jumps: [jumps[0]!] })
    vault.saveHost({ ...input, name: 'direct' })
    const expected = vault.snapshot()
    const legacy = { ...expected, version, hosts: expected.hosts.map(({ jumps, ...host }) => {
      const record: Record<string, unknown> = { ...host, jump: jumps[0] ?? null }
      if (version === 2) delete record.agent
      return record
    }) }
    const before = structuredClone(legacy)
    expect(migrateStore(legacy)).toEqual({ data: expected, migratedFrom: version })
    expect(legacy).toEqual(before)
    const file = path.join(directory, 'vault.json')
    const bytes = JSON.stringify(legacy, null, 2)
    fs.writeFileSync(file, bytes)
    expect(readStoreFile(file)).toEqual({ data: expected, migratedFrom: version, hadRejectedRecords: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    expect(expected.hosts.every((host) => !('jump' in host))).toBe(true)
  })

  it('rejects v10 before reading its fields and never touches the file', () => {
    const file = path.join(directory, 'vault.json')
    const bytes = '{"version":10,"future":"opaque"}'
    fs.writeFileSync(file, bytes)
    const before = fs.statSync(file)
    expect(() => readStoreFile(file)).toThrow(NewerVersionError)
    expect(() => readStoreFile(file)).toThrow('数据文件来自更新版本的 Hopline')
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs)
    expect(fs.readdirSync(directory)).toEqual(['vault.json'])
  })

  it.each(['merge', 'replace'] as const)('round-trips two jumps with all secrets through portable %s and disk', (mode) => {
    const source = createVault()
    const host = source.saveHost({ ...input, jumps })
    const exported = source.exportPortable('fixed')
    expect(exported.version).toBe(8)
    expect(exported.hosts[0]!.jumps).toEqual(jumps.map((jump) => ({ ...jump, agent: null })))
    const target = createVault()
    target.importPortable(JSON.parse(JSON.stringify(exported)), mode)
    expect(target.exportPortable('fixed')).toEqual(exported)
    expect(target.secretsOf(host.id).jumps).toEqual(jumps.map(({ password, privateKey, passphrase }) => ({ password, privateKey, passphrase })))
    const file = path.join(directory, 'vault.json')
    fs.writeFileSync(file, JSON.stringify(target.snapshot()))
    expect(readStoreFile(file).data).toEqual(target.snapshot())
    const copy = target.duplicateHost(host.id)
    copy.jumps[0]!.host = 'external mutation'
    expect(target.getHost(copy.id)!.jumps).toEqual(target.getHost(host.id)!.jumps)
    target.deleteHost(host.id)
    expect(target.snapshot().hosts[0]!.jumps.map(({ passwordEnc, privateKeyEnc, passphraseEnc }) => [passwordEnc, privateKeyEnc, passphraseEnc])).toEqual([[null, null, null], [null, null, null]])
  })

  it.each([1, 2, 3])('imports a v%s portable single jump without losing secrets', (version) => {
    const source = createVault()
    const host = source.saveHost({ ...input, jumps: [jumps[0]!] })
    const exported = source.exportPortable('fixed')
    const legacy = { ...exported, version, hosts: exported.hosts.map(({ jumps, ...record }) => ({ ...record, jump: jumps[0] })) }
    const target = createVault()
    target.importPortable(legacy as never, 'replace')
    expect(target.listHosts()[0]!.jumps).toHaveLength(1)
    expect(target.secretsOf(host.id)).toEqual(source.secretsOf(host.id))
    expect(target.exportPortable('fixed')).toEqual(exported)
  })

  it.each([{ host: 'changed.test' }, { port: 2022 }, { username: 'changed' }])('retains exact ciphertext only at the same index and identity: %j', (change) => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, jumps })
    const before = vault.snapshot().hosts[0]!.jumps
    const updated = omitted()
    updated[1] = { ...updated[1]!, ...change }
    vault.saveHost({ ...input, id: host.id, jumps: updated })
    expect(vault.snapshot().hosts[0]!.jumps[0]).toEqual(before[0])
    expect(vault.secretsOf(host.id).jumps).toEqual([
      { password: 'password1', privateKey: 'key1', passphrase: 'phrase1' },
      { password: null, privateKey: null, passphrase: null }
    ])
  })

  it('does not retain secrets after swapping jump order', () => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, jumps })
    vault.saveHost({ ...input, id: host.id, jumps: omitted().reverse() })
    expect(vault.listHosts()[0]!.jumps.map((jump) => jump.host)).toEqual(['jump2.test', 'jump1.test'])
    expect(vault.secretsOf(host.id).jumps).toEqual(Array(2).fill({ password: null, privateKey: null, passphrase: null }))
  })

  it.each([null, []])('preserves omitted jumps and clears explicit %j', (clear) => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, jumps })
    const before = vault.snapshot().hosts[0]!.jumps
    vault.saveHost({ ...input, id: host.id })
    expect(vault.snapshot().hosts[0]!.jumps).toEqual(before)
    expect(vault.saveHost({ ...input, id: host.id, jumps: clear }).jumps).toEqual([])
    expect(vault.secretsOf(host.id).jumps).toEqual([])
  })

  it('accepts five hops and rejects six before mutating new hosts, edits or imports', () => {
    const vault = createVault()
    const five = Array.from({ length: 5 }, () => jumps[0]!)
    const six = [...five, jumps[1]!]
    const host = vault.saveHost({ ...input, jumps: five })
    expect(host.jumps).toHaveLength(5)
    const before = vault.snapshot()
    for (const id of [undefined, host.id]) {
      expect(() => vault.saveHost({ ...input, id, name: 'changed', jumps: six })).toThrow('跳板最多 5 级')
      expect(vault.snapshot()).toEqual(before)
    }
    const portable = vault.exportPortable()
    portable.hosts[0]!.jumps.push(portable.hosts[0]!.jumps[0]!)
    expect(() => vault.importPortable(portable, 'replace')).toThrow('跳板最多 5 级')
    expect(vault.snapshot()).toEqual(before)
  })
})
