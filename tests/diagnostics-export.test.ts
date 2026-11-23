import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import type { SessionHub } from '../src/main/sessions'
const mock = vi.hoisted(() => ({ save: vi.fn(), reveal: vi.fn() }))
vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0' }, dialog: { showSaveDialog: mock.save }, shell: { showItemInFolder: mock.reveal } }))
import { buildDiagnostics, createDiagnostics, recentLogs, sessionCounts } from '../src/main/diagnostics'
let dir: string, vault: Vault
const sessions = { list: () => [{ id: 'a' }, { id: 'b' }], jobsFor: (id: string) => id === 'a' ? [{}, {}] : [{}] } as unknown as SessionHub
beforeEach(() => {
  vi.clearAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-diagnostics-'))
  vault = new Vault(emptyStore(), new MemorySecretCodec())
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
it('exports allowlisted settings and accurate counts while stripping realistic host and backup information, including logged ciphertext', () => {
  const host = { groupId: null, name: 'prod-db-east', host: 'db.internal.example.net', username: 'deploy-user', port: 22, authType: 'password' as const, password: 'secret-password',
    jumps: [{ host: 'bastion.internal.example.net', username: 'jump-admin', port: 22, authType: 'privateKey' as const, privateKey: 'test-key' }],
    forwards: [{ id: 'rule-1', name: 'database-forward', type: 'local' as const, bindHost: '127.0.0.1', bindPort: 15432, targetHost: '10.30.2.1', targetPort: 5432, autoStart: false }] }
  vault.saveHost(host)
  vault.saveHost({ ...host, name: 'prod-db-west', host: '2001:db8::dead', authType: 'agent', jumps: [], forwards: [] })
  const deleted = vault.saveHost({ ...host, name: 'retired-host' }); vault.deleteHost(deleted.id)
  vault.updateSettings({ language: 'en', theme: 'dark', fontSize: 15, transferConcurrency: 3,
    webdav: { url: 'https://backup.internal.example.net/dav', username: 'backup-user', password: 'dav-secret', remoteDir: 'private-backups' } })
  const data = vault.snapshot()
  const secrets = ['prod-db-east', 'prod-db-west', host.host, host.username, host.jumps[0].host, host.jumps[0].username, '2001:db8::dead', 'retired-host',
    data.hosts[0].passwordEnc!, data.hosts[0].jumps[0].privateKeyEnc!, data.settings.backup.webdav!.url, 'backup-user']
  const text = buildDiagnostics(data, { version: '0.1.0', edition: 'community', ...sessionCounts(sessions) }, [secrets.join(' ')], secrets.join(' '), '/Users/test-user')
  for (const secret of secrets) expect(text).not.toContain(secret)
  expect(text).not.toMatch(/Enc|secret-password|private-backups|rememberUnlock|webdav/)
  const report = JSON.parse(text.split('\n\nWatchdog')[0])
  expect(report.runtime).toMatchObject({ sessions: 2, transfers: 3 })
  expect(report.settings).toMatchObject({ language: 'en', theme: 'dark', fontSize: 15, transferConcurrency: 3 })
  expect(report.hosts).toEqual({ total: 2, authentication: { password: 1, agent: 1 }, jumpDepth: { 0: 1, 1: 1 }, jumpAuthentication: { privateKey: 1 }, forwards: { local: 1 } })
})
it('orders both log files by timestamp without breaking private key blocks, then limits redacted logs and events', async () => {
  fs.writeFileSync(path.join(dir, 'hopline.1.log'), '2026-10-27T12:00:02Z info latest\n')
  fs.writeFileSync(path.join(dir, 'hopline.log'), '2026-10-27T12:00:01Z info -----BEGIN PRIVATE KEY-----\nshort-secret\n-----END PRIVATE KEY-----\n')
  const logs = await recentLogs(dir)
  expect(logs.indexOf('12:00:01')).toBeLessThan(logs.indexOf('12:00:02'))
  const text = buildDiagnostics(vault.snapshot(), {}, Array.from({ length: 60 }, (_, n) => `event-${n}`), logs, '')
  expect(text).not.toContain('short-secret'); expect(text).not.toContain('BEGIN PRIVATE KEY')
  expect(text.split('\n\nWatchdog (latest 50)\n')[1].split('\n\nLogs')[0].split('\n')).toHaveLength(50)
  const many = Array.from({ length: 2100 }, (_, n) => `line-${n}`).join('\n')
  const limited = buildDiagnostics(vault.snapshot(), {}, [], many, '').split('Logs (latest 2000 lines)\n')[1]
  expect(limited.split('\n')).toHaveLength(2000); expect(limited.startsWith('line-100\n')).toBe(true)
  fs.writeFileSync(path.join(dir, 'hopline.2.log'), 'must not be read')
  expect(await recentLogs(dir)).not.toContain('must not be read')
})
it('does not write before Save, saves the exact reviewed text and reveals only successful exports', async () => {
  const service = createDiagnostics(vault, sessions, dir, () => ({} as BrowserWindow))
  const file = path.join(dir, 'report.txt')
  expect(await service.save('unreviewed')).toBe(false); expect(mock.save).not.toHaveBeenCalled()
  const preview = await service.preview()
  expect(fs.readdirSync(dir)).toEqual([]); expect(mock.save).not.toHaveBeenCalled()
  expect(preview).toContain('"edition": "community"'); expect(preview).toContain('"node":')
  await expect(service.save('tampered')).rejects.toThrow('preview changed')
  mock.save.mockResolvedValueOnce({ canceled: true })
  expect(await service.save(preview)).toBe(false); expect(mock.reveal).not.toHaveBeenCalled()
  mock.save.mockResolvedValueOnce({ canceled: false, filePath: file })
  expect(await service.save(preview)).toBe(true)
  expect(fs.readFileSync(file, 'utf8')).toBe(preview)
  expect(mock.save.mock.lastCall![1].defaultPath).toMatch(/^hopline-diagnostics-\d{8}-\d{4}\.txt$/)
  expect(mock.reveal).toHaveBeenCalledWith(file)
})
it('propagates read/write failures and permits a retry after a failed save', async () => {
  fs.mkdirSync(path.join(dir, 'hopline.log'))
  await expect(recentLogs(dir)).rejects.toThrow()
  const service = createDiagnostics(vault, sessions, dir, () => ({} as BrowserWindow))
  const preview = await service.preview()
  mock.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(dir, 'missing', 'report.txt') })
  await expect(service.save(preview)).rejects.toThrow(); expect(mock.reveal).not.toHaveBeenCalled()
  mock.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(dir, 'retry.txt') })
  expect(await service.save(preview)).toBe(true)
})
