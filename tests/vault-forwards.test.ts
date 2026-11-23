import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, it } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import type { ForwardRule, HostInput } from '../src/shared/types'

const input: HostInput = { name: 'host', host: 'localhost', port: 22, username: 'hop', authType: 'password', groupId: null }
const rule: ForwardRule = { id: 'local', type: 'local', bindHost: '127.0.0.1', bindPort: 8080, targetHost: 'localhost', targetPort: 80, autoStart: true }
const create = () => new Vault(emptyStore(), new MemorySecretCodec())
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-v6-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
afterEach(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)) })

it('migrates v5 to v8 without mutating the source or losing other fields', () => {
  const vault = create(); vault.saveHost(input)
  const current = vault.snapshot()
  const old = { ...current, version: 5, hosts: current.hosts.map(({ forwards: _, ...host }) => host) }
  const before = structuredClone(old)
  expect(migrateStore(old)).toEqual({ migratedFrom: 5, data: current })
  expect(old).toEqual(before)
  const file = path.join(dir, 'vault.json'); fs.writeFileSync(file, JSON.stringify(old))
  expect(readStoreFile(file)).toEqual({ data: current, migratedFrom: 5, hadRejectedRecords: false })
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(old)
})

it.each(['merge', 'replace'] as const)('round-trips all three forwarding types via portable %s and disk', (mode) => {
  const vault = create()
  const forwards = [rule, { ...rule, id: 'remote', type: 'remote' as const },
    { ...rule, id: 'dynamic', type: 'dynamic' as const, targetHost: null, targetPort: null }]
  vault.saveHost({ ...input, forwards })
  const portable = vault.exportPortable('fixed'); expect(portable.version).toBe(8)
  const target = create(); target.importPortable(JSON.parse(JSON.stringify(portable)), mode)
  expect(target.exportPortable('fixed')).toEqual(portable)
  const file = path.join(dir, 'vault.json'); fs.writeFileSync(file, JSON.stringify(target.snapshot()))
  expect(readStoreFile(file).data).toEqual(target.snapshot())
  const publicHost = target.listHosts()[0]!; publicHost.forwards[0]!.bindPort = 1
  expect(target.listHosts()[0]!.forwards).toEqual(forwards)
})

it.each([1, 2, 3, 4, 5])('imports portable v%s with empty forwards', (version) => {
  const source = create(); source.saveHost(input)
  const portable = source.exportPortable('fixed')
  const legacy = { ...portable, version, hosts: portable.hosts.map(({ forwards: _, ...host }) => ({ ...host, jump: null })) }
  const target = create(); target.importPortable(legacy as never, 'replace')
  expect(target.listHosts()[0]!.forwards).toEqual([])
})

it('retains omitted rules, clones input, defaults bindHost, canonicalizes dynamic targets and clears explicit []', () => {
  const vault = create(), host = vault.saveHost({ ...input, forwards: [{ ...rule, bindHost: undefined } as never] })
  expect(host.forwards[0]).toEqual(rule)
  expect(vault.saveHost({ ...input, id: host.id }).forwards).toEqual([rule])
  expect(vault.saveHost({ ...input, id: host.id, forwards: [{ ...rule, type: 'dynamic' }] }).forwards[0])
    .toMatchObject({ targetHost: null, targetPort: null })
  expect(vault.saveHost({ ...input, id: host.id, forwards: [] }).forwards).toEqual([])
})

it.each([
  [rule, { ...rule, id: 'duplicate' }], [rule, { ...rule, bindPort: 8081 }],
  [{ ...rule, bindPort: 0 }], [{ ...rule, targetPort: 65536 }], [{ ...rule, bindPort: 1.5 }],
  [{ ...rule, targetHost: '' }], [{ ...rule, type: 'udp' }], [{ ...rule, autoStart: 'yes' }],
  Array.from({ length: 21 }, (_, i) => ({ ...rule, id: `${i}`, bindPort: i + 1 }))
])('rejects invalid rules atomically on save and import: %j', (...forwards) => {
  const vault = create(), host = vault.saveHost({ ...input, forwards: [rule] }), before = vault.snapshot()
  expect(() => vault.saveHost({ ...input, id: host.id, name: 'changed', forwards: forwards as ForwardRule[] })).toThrow()
  expect(vault.snapshot()).toEqual(before)
  const portable = vault.exportPortable(); portable.hosts[0]!.forwards = forwards as ForwardRule[]
  expect(() => vault.importPortable(portable, 'replace')).toThrow()
  expect(vault.snapshot()).toEqual(before)
})
