import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SecurityService } from '../src/main/security-service'
import { OpLog } from '../src/main/oplog'
import { CollectService } from '../src/main/collect-service'
import { parseSecurity } from '../src/core/security/parse'
import { evaluate, securityScore } from '../src/core/security/rules'
import type { ExecOptions, ExecResult } from '../src/main/ssh/pool'
const fixture = fs.readFileSync(new URL('./fixtures/security/unsafe.txt', import.meta.url), 'utf8')
let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-security-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })
const response = (code = 0, stdout = ''): ExecResult => ({ code, stdout, stderr: '', signal: null, timedOut: false, truncated: false })
function setup(mode: 'root' | 'password' | 'nopass' | 'missing' = 'root', collected = fixture) {
  const exec = vi.fn(async (_id: string, command: string, _options?: ExecOptions): Promise<ExecResult> => {
    if (command.includes('===HOPLINE:')) return response(0, collected)
    if (command.includes('id -u')) return response(0, mode === 'root' ? '0' : '1000')
    if (command.includes('command -v sudo')) return response(mode === 'missing' ? 1 : 0)
    if (command.includes('sudo -n true')) return response(mode === 'nopass' ? 0 : 1)
    if (command.includes('exit 10')) return response(10)
    return response()
  })
  const exists = vi.fn(() => true), updated = vi.fn(), log = new OpLog(path.join(directory, 'oplog'))
  const service = new SecurityService(directory, { exec }, log, exists, updated)
  return { exec, exists, updated, log, service }
}
it('collects through the engine with 60s/2MB limits, stores latest and logs only score/count', async () => {
  const { service, exec, log, updated } = setup()
  const report = await service.check('host')
  expect(report.score).toBe(0)
  expect(exec.mock.calls.filter(([, cmd]) => cmd.includes('===HOPLINE:'))).toHaveLength(1)
  expect(exec.mock.calls.every(([, , options]) => options?.timeoutMs === 60000 && options.maxOutputBytes === 2 * 1024 * 1024)).toBe(true)
  expect(log.list('host')).toMatchObject([{ title: '安全体检', reason: 'score=0; failed=15', output: '' }])
  expect(updated).toHaveBeenCalledOnce()
  expect(service.latest('host')).toEqual(report)
  expect(new SecurityService(directory, { exec }, log, () => true).latest('host')).toEqual(report)
})
it.each(['password', 'missing'] as const)('falls back to login user for %s sudo without prompting', async (mode) => {
  const { service, exec } = setup(mode)
  await service.check('host')
  expect(exec.mock.calls.find(([, c]) => c.includes('===HOPLINE:'))?.[2]?.stdin).toBeUndefined()
  expect(exec.mock.calls.some(([, c]) => c.includes('sudo -S'))).toBe(false)
})
it('reuses sudo probing, sends password only over stdin and redacts it from persisted output', async () => {
  const { service, exec, log } = setup('password'), secret = 'one-shot-password'
  const original = exec.getMockImplementation()!
  exec.mockImplementation(async (id, command, options) => command.includes('===HOPLINE:') ? response(0, fixture.replace('private.example.com', secret)) : original(id, command, options))
  const report = await service.check('host', { sudoPassword: secret })
  expect(exec.mock.calls.some(([, , o]) => o?.stdin === `${secret}\n`)).toBe(true)
  expect(exec.mock.calls.every(([, c]) => !c.includes(secret))).toBe(true)
  expect(JSON.stringify(report)).not.toContain(secret)
  expect(fs.readFileSync(path.join(directory, 'security.json'), 'utf8')).not.toContain(secret)
  expect(JSON.stringify(log.list('host'))).not.toContain(secret)
})
it('round-trips per-host ignores atomically, restores scores, and clears deleted hosts', async () => {
  const { service, exec, log, exists } = setup()
  await service.check('host')
  for (const r of service.latest('host')!.results) service.ignore('host', r.id, 'intentional')
  expect(service.latest('host')?.score).toBe(100)
  const reopened = new SecurityService(directory, { exec }, log, exists)
  expect(reopened.latest('host')?.ignores['firewall-off'].note).toBe('intentional')
  expect(reopened.ignore('host', 'firewall-off', null).score).toBe(80)
  expect(fs.existsSync(path.join(directory, 'security-ignores.json.tmp'))).toBe(false)
  exists.mockReturnValue(false); reopened.prune()
  expect(reopened.latest('host')).toBeNull()
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'security-ignores.json'), 'utf8'))).toEqual({ version: 1, hosts: {} })
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'))).toEqual({})
})
it.each([{ timedOut: true }, { truncated: true }, { signal: 'TERM' }, { code: 1 }])('does not save an unsuccessful collection %j', async (change) => {
  const { service, exec, log } = setup(), original = exec.getMockImplementation()!
  exec.mockImplementation(async (id, command, options) => command.includes('===HOPLINE:') ? { ...response(0, fixture), ...change } : original(id, command, options))
  await expect(service.check('host')).rejects.toThrow()
  expect(service.latest('host')).toBeNull(); expect(log.list('host')).toEqual([])
})
it('rejects concurrent checks and does not resurrect a host deleted in flight', async () => {
  const { service, exec, exists } = setup()
  let resume!: (r: ExecResult) => void
  exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const pending = service.check('host')
  await expect(service.check('host')).rejects.toThrow('security.busy')
  exists.mockReturnValue(false); service.prune(); resume(response(0, '0'))
  await expect(pending).rejects.toThrow()
  expect(service.latest('host')).toBeNull()
})
it('publishes the latest security score with inventory and updates without a new SSH collection', () => {
  const updated = vi.fn(), { service } = setup()
  let score = 70
  fs.writeFileSync(path.join(directory, 'snapshots.json'), JSON.stringify({ host: { snapshot: null, error: null, updatedAt: null } }))
  const collect = new CollectService({ pool: { acquire: vi.fn(), isOpen: () => false }, hosts: () => [{ id: 'host' }], filePath: path.join(directory, 'snapshots.json'), updated, securityScore: () => score })
  try {
    expect(collect.latest().host.securityScore).toBe(70)
    score = 95; collect.securityUpdated()
    expect(updated).toHaveBeenLastCalledWith(expect.objectContaining({ host: expect.objectContaining({ securityScore: 95 }) }))
    expect(service.latest('host')).toBeNull()
  } finally { collect.stop() }
})

const safeExceptDatabase = fixture.replace('VERSION_ID="10"', 'VERSION_ID="12"')
  .replace('permitrootlogin yes', 'permitrootlogin no').replace('passwordauthentication yes', 'passwordauthentication no')
  .replace('permitemptypasswords yes', 'permitemptypasswords no').replace('port 22', 'port 2222')
  .replace('Status: inactive', 'Status: active').replace('[::]:2375', '[::]:2376').replace('auto=no', 'auto=yes')
  .replace('Debian-Security:10/buster-security', 'Debian:10/buster').replace('reboot=yes', 'reboot=no')
  .replace('uid0=backup\n', '').replace('empty=guest\n', '').replace('xmrig /tmp/xmrig --donate-level 1', 'sleep sleep 100')
  .replace('Oct 28 10:20:30 2026', 'Oct 28 10:20:30 2027')

it.each(['3306', '22', 'yes', 'no', 'HOPLINE', '===HOPLINE:listeners===', '#HOPLINE-END', 'LISTEN'])(
  'keeps diagnostic findings intact when the sudo password equals protocol text %j', async (secret) => {
    const now = Date.UTC(2026, 10, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const expected = evaluate(parseSecurity(safeExceptDatabase, now), {}, now)
    const { service, exec, log, updated } = setup('password', safeExceptDatabase)
    const report = await service.check('host', { sudoPassword: secret })
    expect(report.score).toBe(80)
    expect(report.score).toBe(securityScore(expected))
    expect(report.results.map(({ id, status }) => ({ id, status }))).toEqual(expected.map(({ id, status }) => ({ id, status })))
    expect(report.results.find(({ id }) => id === 'db-exposed')?.status).toBe('fail')
    expect(report.snapshot.listeners).toMatchObject({ status: 'complete', data: expect.arrayContaining([expect.objectContaining({ port: 3306, protocol: 'tcp' })]) })
    expect(report.snapshot.sshd).toMatchObject({ status: 'complete', data: { port: '2222', permitrootlogin: 'no', passwordauthentication: 'no' } })
    expect(report.snapshot.updates).toMatchObject({ status: 'complete', data: { auto: true, reboot: false, pending: 0 } })
    expect(JSON.parse(report.results.find(({ id }) => id === 'db-exposed')!.evidence).params.raw).toContain('3306')
    expect(updated).toHaveBeenCalledOnce()
    expect(new SecurityService(directory, { exec }, log, () => true).latest('host')).toEqual(report)
    expect(log.list('host')).toMatchObject([{ reason: 'score=80; failed=1', output: '' }])
  }
)

it.each(['xmrig', 'backup', 'yes', 'no'])('preserves original findings through ignore/unignore after redacting %j', async (secret) => {
  const { service, exec, log } = setup('password', fixture.replace(' --donate-level 1', ''))
  const report = await service.check('host', { sudoPassword: secret })
  const original = report.results.map(({ id, status }) => ({ id, status }))
  for (const { id } of report.results) service.ignore('host', id, '用户确认')
  expect(service.latest('host')?.score).toBe(100)
  const reopened = new SecurityService(directory, { exec }, log, () => true)
  for (const { id } of report.results) reopened.ignore('host', id, null)
  expect(reopened.latest('host')?.results.map(({ id, status }) => ({ id, status }))).toEqual(original)
  expect(reopened.latest('host')?.score).toBe(report.score)
  if (secret === 'xmrig') {
    expect(JSON.stringify(reopened.latest('host'))).not.toContain(secret)
    expect(reopened.latest('host')?.results.find(({ id }) => id === 'miner-process')?.status).toBe('fail')
  }
})

it('retains a legacy plain-evidence finding through repeated ignore toggles without reclassifying redacted text', async () => {
  const { service, exec, log } = setup('password', fixture.replace(' --donate-level 1', ''))
  const report = await service.check('host', { sudoPassword: 'xmrig' })
  report.results.find(result => result.id === 'miner-process')!.evidence = '["/tmp/***"]'
  fs.writeFileSync(path.join(directory, 'security.json'), JSON.stringify({ host: report }))
  const reopened = new SecurityService(directory, { exec }, log, () => true)
  reopened.ignore('host', 'miner-process', '用户确认')
  const restored = reopened.ignore('host', 'miner-process', null)
  expect(restored.results.find(result => result.id === 'miner-process')?.status).toBe('fail')
  expect(restored.score).toBe(report.score)
})

it.each(['audit_secret', 'audit"\\secret'])(
  'redacts genuine secret text from observations, nested evidence, persisted reports and notifications: %j', async (secret) => {
    const collected = fixture.replace('private.example.com', secret).replace('Debian GNU/Linux 10', secret)
      .replace('/tmp/xmrig', `/tmp/${secret}/xmrig`).replace('uid0=backup', `uid0=${secret}`)
      .replace('empty=guest', `empty=${secret}`).replace('mysqld', `worker-${secret.replaceAll('"', '')}`)
      .replace('#HOPLINE-SOURCE effective', `#HOPLINE-SOURCE effective\n#HOPLINE-PARTIAL ${secret}`)
    const { service, exec, log, updated } = setup('password', collected)
    updated.mockImplementation(() => {
      const publication = JSON.stringify(service.latest('host'))
      expect(publication).not.toContain(JSON.stringify(secret).slice(1, -1))
    })
    const report = await service.check('host', { sudoPassword: secret })
    const encoded = JSON.stringify(secret).slice(1, -1)
    expect(JSON.stringify(report)).not.toContain(encoded)
    expect(fs.readFileSync(path.join(directory, 'security.json'), 'utf8')).not.toContain(encoded)
    expect(JSON.stringify(log.list('host'))).not.toContain(encoded)
    expect(report.snapshot.processes.status !== 'unavailable' && report.snapshot.processes.data.some(line => line.includes('/tmp/***/xmrig'))).toBe(true)
    expect(report.results.find(result => result.id === 'uid0-accounts')?.fix?.commands).toBe('')
    expect(updated).toHaveBeenCalledOnce()
    expect(new SecurityService(directory, { exec }, log, () => true).latest('host')).toEqual(report)
  }
)
