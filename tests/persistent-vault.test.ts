import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore, STORE_VERSION } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import { parseLayout, serializeLayout } from '../src/renderer/src/logic/layout'
const input = { groupId: null, name: 'host', host: 'localhost', port: 22, username: 'hop', authType: 'password' as const }
const create = () => new Vault(emptyStore(), new MemorySecretCodec())

it('migrates v6 to v9 by adding persistent:false and default connection settings, without mutating input', () => {
  const vault = create(); vault.saveHost(input)
  const current = vault.snapshot(), old = { ...current, version: 6, hosts: current.hosts.map(({ persistent: _, ...host }) => host) }
  const before = structuredClone(old)
  expect(STORE_VERSION).toBe(9)
  expect(migrateStore(old)).toEqual({ data: current, migratedFrom: 6 })
  expect(old).toEqual(before)
  expect(migrateStore(current).migratedFrom).toBeNull()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-persistent-vault-')), file = path.join(directory, 'store.json')
  try {
    fs.writeFileSync(file, JSON.stringify(old))
    expect(readStoreFile(file)).toEqual({ data: current, migratedFrom: 6, hadRejectedRecords: false })
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

it.each(['merge', 'replace'] as const)('round-trips persistent in portable %s, retains omitted values and defaults legacy imports', (mode) => {
  const source = create(), host = source.saveHost({ ...input, persistent: true })
  expect(source.saveHost({ ...input, id: host.id }).persistent).toBe(true)
  expect(source.duplicateHost(host.id).persistent).toBe(true)
  const portable = source.exportPortable('fixed'), target = create()
  expect(portable.version).toBe(8)
  target.importPortable(JSON.parse(JSON.stringify(portable)), mode)
  expect(target.exportPortable('fixed')).toEqual(portable)
  const legacy = { ...portable, version: 6, hosts: portable.hosts.map(({ persistent: _, ...item }) => item) }
  target.importPortable(legacy as never, 'replace')
  expect(target.listHosts().every((item) => item.persistent === false)).toBe(true)
  expect(source.saveHost({ ...input, id: host.id, persistent: false }).persistent).toBe(false)
})

it('rejects invalid persistent input atomically on save/import and makes tombstones inert', () => {
  const vault = create(), host = vault.saveHost(input), before = vault.snapshot()
  expect(() => vault.saveHost({ ...input, id: host.id, persistent: 'yes' as never })).toThrow()
  const portable = vault.exportPortable(); portable.hosts[0].persistent = 'yes' as never
  expect(() => vault.importPortable(portable, 'replace')).toThrow()
  expect(vault.snapshot()).toEqual(before)
  vault.deleteHost(host.id)
  const target = create(); target.importPortable(vault.exportPortable(), 'replace')
  expect(target.snapshot().hosts[0].persistent).toBe(false)
})

it('saves per-tab tmux identity and accepts old layouts, rejecting unsafe names or extra secrets', () => {
  const tab = { id: 'id', kind: 'ssh' as const, hostId: 'host', tmuxName: 'hopline-a1b2c3' }
  expect(parseLayout(serializeLayout([tab], tab.id))).toEqual({ tabs: [{ kind: 'ssh', hostId: 'host', tmuxName: tab.tmuxName }], activeIndex: 0 })
  expect(parseLayout('{"tabs":[{"kind":"ssh","hostId":"host"}],"activeIndex":0}')).not.toBeNull()
  for (const tmuxName of ['bad', 'hopline-a;echo', 'hopline-$(id)']) expect(parseLayout(JSON.stringify({ tabs: [{ kind: 'ssh', hostId: 'host', tmuxName }], activeIndex: 0 }))).toBeNull()
})
