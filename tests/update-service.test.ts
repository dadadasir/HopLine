import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UpdateService, UPDATE_INTERVAL_MS, UPDATE_STARTUP_DELAY_MS } from '../src/main/update-service'
import { RELEASE_PAGE_PREFIX } from '../src/core/updates'

const release = { tag_name: 'v0.4.0', html_url: `${RELEASE_PAGE_PREFIX}v0.4.0`, body: '修复', draft: false, prerelease: false }
let directory: string
const services: UpdateService[] = []
const make = (options: ConstructorParameters<typeof UpdateService>[2] = {}) => {
  const service = new UpdateService(directory, '0.3.0', options)
  services.push(service)
  return service
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-updates-'))
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 11) })
})
afterEach(() => {
  services.splice(0).forEach(service => service.stop())
  vi.restoreAllMocks(); vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('delays the first automatic request, notifies once, and limits running checks to daily', async () => {
  const request = vi.fn(async () => release), onAvailable = vi.fn()
  const service = make({ request, onAvailable })
  service.start(); service.start()
  await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY_MS - 1)
  expect(request).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(1)
  expect(onAvailable).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS - 1)
  expect(request).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(2)
  expect(onAvailable).toHaveBeenCalledTimes(2)
})

it('persists opt-out and attempts across restart, including automatic network failures', async () => {
  const request = vi.fn(async () => { throw new Error('private detail must never be logged') }), onAvailable = vi.fn()
  const errorLog = vi.spyOn(console, 'error'), log = vi.spyOn(console, 'log')
  const service = make({ request, onAvailable })
  expect(await service.check(false)).toBeNull()
  const lastAttemptAt = service.preferences().lastAttemptAt
  expect(lastAttemptAt).toBe(Date.now())
  const restarted = make({ request, onAvailable })
  expect(restarted.preferences()).toEqual({ automatic: true, lastAttemptAt })
  expect(await restarted.check(false)).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
  expect(onAvailable).not.toHaveBeenCalled()
  expect(errorLog).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
  service.setAutomatic(false)
  const optedOut = make({ request })
  optedOut.start()
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
  expect(await optedOut.check(false)).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
  expect(optedOut.preferences()).toEqual({ automatic: false, lastAttemptAt })
})

it('allows manual requests when disabled and returns sanitized failures while consuming the automatic daily budget', async () => {
  const request = vi.fn(async () => { throw new Error('my-host secret diagnostic') })
  const service = make({ request })
  service.setAutomatic(false)
  expect(await service.check(true)).toEqual({ status: 'error', reason: 'network' })
  expect(await service.check(true)).toEqual({ status: 'error', reason: 'network' })
  expect(request).toHaveBeenCalledTimes(2)
  service.setAutomatic(true)
  expect(await service.check(false)).toBeNull()
  expect(request).toHaveBeenCalledTimes(2)
  expect(fs.readFileSync(path.join(directory, 'updates.json'), 'utf8')).not.toMatch(/my-host|secret/)
})

it('returns current/new/malformed results manually and suppresses automatic malformed errors', async () => {
  const request = vi.fn().mockResolvedValueOnce(release).mockResolvedValueOnce({ ...release, tag_name: 'v0.3.0', html_url: `${RELEASE_PAGE_PREFIX}v0.3.0` }).mockResolvedValue({ message: 'untrusted response' })
  const onAvailable = vi.fn(), service = make({ request, onAvailable })
  expect(await service.check(true)).toMatchObject({ status: 'available', release: { version: '0.4.0' } })
  expect(await service.check(true)).toEqual({ status: 'current' })
  expect(await service.check(true)).toEqual({ status: 'error', reason: 'invalid' })
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS)
  expect(await service.check(false)).toBeNull()
  expect(onAvailable).not.toHaveBeenCalled()
})

it('coalesces concurrent manual/automatic requests and avoids duplicate automatic delivery when manual joins', async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn(() => new Promise(resolve => { finish = resolve })), onAvailable = vi.fn()
  const service = make({ request, onAvailable })
  const automatic = service.check(false), manual = service.check(true), another = service.check(true)
  expect(request).toHaveBeenCalledTimes(1)
  finish(release)
  const results = await Promise.all([automatic, manual, another])
  expect(results).toEqual(Array(3).fill({ status: 'available', release: { version: '0.4.0', url: release.html_url, summary: '修复' } }))
  expect(onAvailable).not.toHaveBeenCalled()
})

it('turning automatic checks off aborts their request and suppresses late results, but manual remains usable', async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(release), onAvailable = vi.fn()
  const service = make({ request, onAvailable })
  const automatic = service.check(false)
  service.setAutomatic(false)
  expect(request.mock.calls[0][0].aborted).toBe(true)
  expect(await service.check(true)).toMatchObject({ status: 'available' })
  finish(release)
  expect(await automatic).toBeNull()
  expect(onAvailable).not.toHaveBeenCalled()
})

it('stopping cancels the pending request, timer, and late delivery', async () => {
  let finish!: (value: unknown) => void
  const request = vi.fn((_signal: AbortSignal) => new Promise(resolve => { finish = resolve })), onAvailable = vi.fn()
  const service = make({ request, onAvailable })
  service.start()
  const pending = service.check(false)
  const signal = request.mock.calls[0][0] as AbortSignal
  service.stop(); finish(release)
  expect(signal.aborted).toBe(true)
  expect(await pending).toBeNull()
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 3)
  expect(await service.check(true)).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
  expect(onAvailable).not.toHaveBeenCalled()
})

it('a clock rollback cannot force another automatic request or overflow the timer', async () => {
  const request = vi.fn(async () => release), service = make({ request })
  await service.check(false)
  vi.setSystemTime(Date.now() - UPDATE_INTERVAL_MS * 40)
  service.start()
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
  expect(request).toHaveBeenCalledTimes(1)
})

it('does not request if frequency cannot be persisted, and a failed opt-out write preserves its previous value', async () => {
  const request = vi.fn(async () => release), service = make({ request })
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('private filesystem detail') })
  expect(await service.check(true)).toEqual({ status: 'error', reason: 'storage' })
  expect(await service.check(false)).toBeNull()
  expect(() => service.setAutomatic(false)).toThrow('updates.error.storage')
  expect(service.preferences()).toEqual({ automatic: true, lastAttemptAt: null })
  expect(request).not.toHaveBeenCalled()
  rename.mockRestore()
})

it('preserves corrupt preference bytes and disables automatic checks until explicitly re-enabled', async () => {
  const raw = '{"automatic":false, broken'
  fs.writeFileSync(path.join(directory, 'updates.json'), raw)
  const request = vi.fn(async () => release), service = make({ request })
  expect(service.preferences()).toEqual({ automatic: false, lastAttemptAt: null })
  expect(await service.check(false)).toBeNull()
  const preserved = fs.readdirSync(directory).find(name => name.startsWith('updates.corrupt-'))!
  expect(fs.readFileSync(path.join(directory, preserved), 'utf8')).toBe(raw)
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'updates.json'), 'utf8'))).toEqual({ automatic: false, lastAttemptAt: null })
  const restarted = make({ request })
  restarted.start()
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
  expect(restarted.preferences()).toEqual({ automatic: false, lastAttemptAt: null })
  expect(request).not.toHaveBeenCalled()
  restarted.setAutomatic(true)
  expect(await restarted.check(false)).toMatchObject({ status: 'available' })
  expect(fs.readFileSync(path.join(directory, preserved), 'utf8')).toBe(raw)
})

it('a failed recovery-state write cannot re-enable requests after another restart', async () => {
  const raw = '{"automatic":false, broken'
  const file = path.join(directory, 'updates.json')
  fs.writeFileSync(file, raw)
  const originalRename = fs.renameSync
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(source).endsWith('updates.json.tmp')) throw new Error('failed to persist recovered opt-out')
    return originalRename(source, destination)
  })
  const request = vi.fn(async () => release)
  for (let attempt = 0; attempt < 2; attempt++) {
    const restarted = make({ request })
    expect(restarted.preferences().automatic).toBe(false)
    expect(await restarted.check(false)).toBeNull()
    expect(await restarted.check(true)).toEqual({ status: 'error', reason: 'storage' })
    expect(() => restarted.setAutomatic(true)).toThrow('updates.error.storage')
    expect(fs.existsSync(file)).toBe(false)
  }
  rename.mockRestore()
  const recovered = make({ request })
  expect(recovered.preferences().automatic).toBe(false)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ automatic: false, lastAttemptAt: null })
  expect(await recovered.check(false)).toBeNull()
  expect(request).not.toHaveBeenCalled()
  const preserved = fs.readdirSync(directory).find(name => name.startsWith('updates.corrupt-'))!
  expect(fs.readFileSync(path.join(directory, preserved), 'utf8')).toBe(raw)
  recovered.setAutomatic(true)
  expect(await recovered.check(false)).toMatchObject({ status: 'available' })
})

it('returns preference copies and rejects non-boolean settings without changing data', () => {
  const service = make()
  const returned = service.preferences(); returned.automatic = false
  expect(service.preferences().automatic).toBe(true)
  expect(() => service.setAutomatic('yes' as unknown as boolean)).toThrow('updates.error.invalid')
  expect(fs.existsSync(path.join(directory, 'updates.json'))).toBe(false)
})

it('an unreadable preference file stays untouched and cannot accidentally enable network requests', async () => {
  const file = path.join(directory, 'updates.json')
  const raw = JSON.stringify({ automatic: false, lastAttemptAt: null })
  fs.writeFileSync(file, raw)
  const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('EACCES private path') })
  const request = vi.fn(async () => release), service = make({ request })
  read.mockRestore()
  expect(service.preferences().automatic).toBe(false)
  expect(await service.check(false)).toBeNull()
  expect(await service.check(true)).toEqual({ status: 'error', reason: 'storage' })
  expect(() => service.setAutomatic(true)).toThrow('updates.error.storage')
  expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  expect(request).not.toHaveBeenCalled()
})
