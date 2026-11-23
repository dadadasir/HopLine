import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { CollectService } from '../src/main/collect-service'
import { SshConnectionError } from '../src/main/ssh/connect'
import { parseCollect } from '../src/core/collect/parse'
import type { HostSnapshot } from '../src/shared/types'
import { getEditionCapabilities } from '../src/ext/capabilities'
import type { CollectionIntervalMinutes } from '../src/shared/types'

vi.mock('../src/main/logger', () => ({ logError: vi.fn() }))
const snapshot = () => parseCollect('===HOPLINE:uptime===\n42 0\n\n#HOPLINE-END\n', Date.now())
let directory: string, services: CollectService[]
let hosts: { id: string }[]
const release = vi.fn(), updated = vi.fn()
const pool = { isOpen: vi.fn(), acquire: vi.fn() }
const collect = vi.fn()
function create(overviewHostLimit?: number | (() => number), preferences?: () => { autoCollect: boolean; collectionIntervalMinutes: CollectionIntervalMinutes }) {
  const service = new CollectService({ pool, hosts: () => hosts, filePath: path.join(directory, 'snapshots.json'), updated, collect, overviewHostLimit, preferences })
  services.push(service)
  return service
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T00:00:00Z')); vi.resetAllMocks()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-collect-service-'))
  services = []; hosts = [{ id: 'open' }, { id: 'closed' }]
  pool.isOpen.mockImplementation((id) => id === 'open')
  pool.acquire.mockResolvedValue({ client: {}, release, onDrop: () => () => {} })
  collect.mockImplementation(async () => snapshot())
})
afterEach(() => {
  services.forEach((service) => service.stop()); vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('collection scheduling and persistence', () => {
  it.each(['community', 'pro'] as const)('collects the ordered %s scope without interaction and keeps later hosts manually accessible', async edition => {
    hosts = ['third', 'first', 'fifth', 'second', 'fourth', 'sixth', 'seventh'].map(id => ({ id }))
    const limit = getEditionCapabilities(edition).overviewHostLimit
    const scoped = hosts.slice(0, limit)
    const service = create(limit)
    service.setOverviewOpen(true)
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.acquire.mock.calls).toEqual(scoped.map(({ id }) => [id, { interaction: 'forbid', signal: expect.any(AbortSignal) }]))
    expect(collect.mock.calls.map(([, id]) => id)).toEqual(scoped.map(host => host.id))
    if (edition === 'community') {
      expect(service.latest().sixth).toBeUndefined()
      expect((await service.run('sixth')).snapshot?.uptime).toMatchObject({ status: 'complete' })
      expect(pool.acquire).toHaveBeenLastCalledWith('sixth', { signal: expect.any(AbortSignal) })
    }
  })

  it('recomputes targets when their order, membership or edition changes', async () => {
    hosts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id }))
    let limit = 5
    const service = create(() => limit)
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(service.latest())).toEqual(['a','b','c','d','e'])
    const existing = service.latest().b.updatedAt
    hosts = [hosts[5], ...hosts.slice(1,5), hosts[6]]
    service.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(service.latest())).toEqual(['b','c','d','e','f'])
    expect(service.latest().b.updatedAt).toBe(existing)
    limit = Infinity
    service.settingsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.acquire.mock.calls.map(([id]) => id)).toEqual(['a','b','c','d','e','f','g'])
  })

  it('uses one minute in Overview, the selected interval elsewhere, and resumes overdue work on show', async () => {
    hosts = [{ id: 'open' }]
    const settings = { autoCollect: true, collectionIntervalMinutes: 15 as CollectionIntervalMinutes }
    const service = create(5, () => settings)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(pool.acquire).not.toHaveBeenCalled()
    service.setOverviewOpen(true)
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(collect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(collect).toHaveBeenCalledTimes(2)
    service.setOverviewOpen(false)
    await vi.advanceTimersByTimeAsync(899_999)
    expect(collect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(collect).toHaveBeenCalledTimes(3)
    service.setWindowOpen(false)
    expect(release).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000_000)
    expect(collect).toHaveBeenCalledTimes(3)
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(collect).toHaveBeenCalledTimes(4)
    settings.collectionIntervalMinutes = 1
    service.settingsChanged()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(collect).toHaveBeenCalledTimes(5)
    settings.autoCollect = false
    service.settingsChanged()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(collect).toHaveBeenCalledTimes(5)
  })

  it('pauses an unfinished automatic attempt and discards its late data when hidden', async () => {
    hosts = [{ id: 'open' }]
    const service = create()
    let finish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    const signal = pool.acquire.mock.calls[0][1].signal as AbortSignal
    service.setWindowOpen(false)
    expect(signal.aborted).toBe(true)
    finish(snapshot())
    await vi.advanceTimersByTimeAsync(300_000)
    expect(updated).not.toHaveBeenCalled()
    expect(service.latest()).toEqual({})
  })

  it('waits for an authenticated session after needs-attention without ever requesting interactive auth automatically', async () => {
    hosts = [{ id: 'closed' }]
    pool.acquire.mockRejectedValueOnce(new SshConnectionError('host-key', 'Fingerprint requires confirmation'))
    const service = create()
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(service.latest().closed).toMatchObject({ needsAttention: true, snapshot: null })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(pool.acquire).toHaveBeenCalledOnce()
    await expect(service.runConnected('closed')).rejects.toThrow('连接已断开')
    pool.isOpen.mockReturnValue(true)
    expect(await service.runConnected('closed')).toMatchObject({ error: null, snapshot: { uptime: { status: 'complete' } } })
    expect(service.latest().closed.needsAttention).toBeUndefined()
    expect(pool.acquire.mock.calls.every(([, options]) => options.interaction === 'forbid')).toBe(true)
  })

  it('backs off connection failures by 5, 10, 20, then at most 30 minutes', async () => {
    hosts = [{ id: 'closed' }]
    pool.acquire.mockRejectedValue(new SshConnectionError('connection', 'Fixture offline'))
    const service = create()
    service.setOverviewOpen(true)
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.acquire).toHaveBeenCalledOnce()
    let attempts = 1
    for (const minutes of [5, 10, 20, 30, 30]) {
      await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1)
      service.setWindowOpen(true)
      expect(pool.acquire).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(pool.acquire).toHaveBeenCalledTimes(++attempts)
    }
    pool.acquire.mockResolvedValue({ client: {}, release, onDrop: () => () => {} })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(service.latest().closed.error).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pool.acquire).toHaveBeenCalledTimes(attempts + 2)
  })

  it('manual collection can connect and all overlapping calls share the same promise', async () => {
    const service = create()
    let finish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const a = service.run('closed'), b = service.run('closed')
    expect(a).toBe(b)
    await Promise.resolve()
    expect(collect).toHaveBeenCalledTimes(1)
    finish(snapshot()); await a
    expect(release).toHaveBeenCalledTimes(1)
    expect(updated).toHaveBeenCalledTimes(1)
    expect(service.latest().closed.snapshot?.uptime).toEqual({ status: 'complete', data: { seconds: 42 } })
  })
  it('automatic and manual refresh share the same collection', async () => {
    hosts = [{ id: 'open' }]
    const service = create(); service.setOverviewOpen(true); service.setWindowOpen(true)
    let finish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(0)
    const pending = service.run('open')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(collect).toHaveBeenCalledTimes(1)
    finish(snapshot()); await pending
  })
  it('retains the latest successful snapshot/time on error, persists it and clears error after success', async () => {
    const service = create(), successful = await service.run('open')
    await vi.advanceTimersByTimeAsync(60_000)
    collect.mockRejectedValueOnce(new Error('denied'))
    const failed = await service.run('open')
    expect(failed).toEqual({ ...successful, error: 'denied' })
    service.stop()
    const reloaded = create()
    expect(reloaded.latest()).toEqual({ open: failed })
    expect(fs.existsSync(path.join(directory, 'snapshots.json.tmp'))).toBe(false)
    const files = fs.readdirSync(directory)
    expect(files).toEqual(['snapshots.json'])
    expect((await reloaded.run('open')).error).toBe(null)
    expect(reloaded.latest().open.updatedAt).toBe(Date.now())
  })
  it('records first connection errors without fabricating a snapshot', async () => {
    const service = create(); pool.acquire.mockRejectedValueOnce(new Error('auth'))
    expect(await service.run('closed')).toEqual({ snapshot: null, updatedAt: null, error: 'auth' })
    expect(collect).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
  })
  it('prunes deleted hosts on disk and does not resurrect an in-flight deleted host', async () => {
    const service = create(); await service.run('open')
    let finish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = service.run('closed'); await Promise.resolve()
    hosts = []; service.prune()
    expect(service.latest()).toEqual({})
    finish(snapshot()); await pending
    expect(service.latest()).toEqual({})
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'snapshots.json'), 'utf8'))).toEqual({})
    await expect(service.run('open')).rejects.toThrow('主机不存在')
  })
  it('prunes snapshots on startup when hosts were removed while the app was closed', async () => {
    const service = create(); await service.run('open'); service.stop(); hosts = []
    expect(create().latest()).toEqual({})
  })
  it('stops timers, suppresses late writes, and rejects work after exit', async () => {
    const service = create(); service.setOverviewOpen(true)
    let finish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = service.run('open'); await Promise.resolve()
    service.stop(); service.setOverviewOpen(true)
    expect(vi.getTimerCount()).toBe(0)
    finish(snapshot()); await pending
    await vi.advanceTimersByTimeAsync(600_000)
    expect(updated).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1)
    await expect(service.run('open')).rejects.toThrow('采集服务已停止')
  })
  it('executes on the reserved lease without acquiring another connection after a drop', async () => {
    const service = create(), client = Object.assign(new EventEmitter(), { exec: vi.fn((_script, callback) => callback(new Error('connection lost'))) })
    pool.acquire.mockResolvedValueOnce({ client: client as unknown as Client, release })
    collect.mockImplementationOnce((executor, id) => executor.exec(id, 'probe'))
    expect((await service.run('open')).error).toBe('connection lost')
    expect(pool.acquire).toHaveBeenCalledTimes(1); expect(client.exec).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('returns isolated records and preserves corrupt JSON before starting empty', async () => {
    const service = create(); await service.run('open')
    service.latest().open.error = 'mutation'
    expect(service.latest().open.error).toBe(null)
    service.stop(); fs.writeFileSync(path.join(directory, 'snapshots.json'), '{broken')
    expect(create().latest()).toEqual({})
    expect(fs.readdirSync(directory).some((name) => name.startsWith('snapshots.corrupt-'))).toBe(true)
  })
})

it('quarantines a wrong section shape instead of sending unusable arrays to the renderer', () => {
  const broken = snapshot()
  broken.disk = { status: 'complete', data: {} as never }
  fs.writeFileSync(path.join(directory, 'snapshots.json'), JSON.stringify({ open: { snapshot: broken, updatedAt: Date.now(), error: null } }))
  expect(create().latest()).toEqual({})
  expect(fs.readdirSync(directory).some((name) => name.startsWith('snapshots.corrupt-'))).toBe(true)
})


describe('generic background collection', () => {
  it('shares one attempt and lease with foreground sampling and preserves manual Promise identity', async () => {
    const service = create()
    let finish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const a = service.runBackground('open'), b = service.runBackground('open')
    const manual = service.run('open')
    expect(a).toBe(b)
    expect(service.run('open')).toBe(manual)
    expect(pool.acquire).toHaveBeenCalledExactlyOnceWith('open', { interaction: 'forbid', signal: expect.any(AbortSignal) })
    await Promise.resolve()
    finish(snapshot())
    const result = await a
    expect(result).toMatchObject({ status: 'success', at: Date.now(), record: { error: null, updatedAt: Date.now() } })
    expect(result.attemptId).toMatch(/^[a-f0-9-]+$/)
    expect(await b).toEqual(result)
    expect(await manual).toEqual(result.record)
    expect(collect).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not wait for a foreground authentication prompt or acquire another connection', async () => {
    const service = create()
    let allow!: (value: { client: object; release: typeof release }) => void
    pool.acquire.mockImplementationOnce(() => new Promise(resolve => { allow = resolve }))
    const manual = service.run('closed')
    const background = await service.runBackground('closed')
    expect(background).toMatchObject({ status: 'needs-attention', reason: 'authentication', record: { snapshot: null } })
    expect(pool.acquire).toHaveBeenCalledOnce()
    expect(collect).not.toHaveBeenCalled()
    allow({ client: {}, release })
    expect((await manual).error).toBe(null)
  })

  it('restores normal foreground authentication after a background attempt needs attention', async () => {
    const service = create()
    let reject!: (error: Error) => void
    pool.acquire.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
    const background = service.runBackground('closed'), manual = service.run('closed')
    expect(service.run('closed')).toBe(manual)
    reject(new SshConnectionError('host-key', '主机指纹需要确认'))
    expect(await background).toMatchObject({ status: 'needs-attention', reason: 'host-key' })
    expect((await manual).error).toBe(null)
    expect(pool.acquire.mock.calls).toEqual([
      ['closed', { interaction: 'forbid', signal: expect.any(AbortSignal) }],
      ['closed', { signal: expect.any(AbortSignal) }]
    ])
    expect(collect).toHaveBeenCalledOnce()
  })

  it.each([
    [new SshConnectionError('connection', '连接被拒绝'), 'connection-failed', 'connection'],
    [new Error('jump failed', { cause: new SshConnectionError('connection', '连接超时') }), 'connection-failed', 'connection'],
    [new SshConnectionError('host-key', '主机指纹需要确认'), 'needs-attention', 'host-key'],
    [new SshConnectionError('authentication', '认证失败'), 'needs-attention', 'authentication'],
    [Object.assign(new Error('locked'), { name: 'LockedError' }), 'needs-attention', 'locked'],
    [new Error('unknown failure'), 'unavailable', 'collection']
  ] as const)('classifies %s without treating cached metrics as a new success', async (error, status, reason) => {
    const service = create(), before = await service.run('open')
    await vi.advanceTimersByTimeAsync(1000)
    pool.acquire.mockRejectedValueOnce(error)
    const result = await service.runBackground('open')
    expect(result).toMatchObject({ status, reason, at: Date.now(), record: { snapshot: before.snapshot, updatedAt: before.updatedAt, error: error.message } })
    expect(collect).toHaveBeenCalledOnce()
  })

  it('distinguishes a collection/script failure from a failed SSH connection', async () => {
    const service = create()
    collect.mockRejectedValueOnce(new Error('主机采集失败: 127'))
    expect(await service.runBackground('open')).toMatchObject({ status: 'unavailable', reason: 'collection' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('does no ordinary overview work while there is no window but permits explicit background sampling', async () => {
    const service = create(); service.setOverviewOpen(true); service.setWindowOpen(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(pool.isOpen).not.toHaveBeenCalled(); expect(pool.acquire).not.toHaveBeenCalled()
    expect((await service.runBackground('closed')).status).toBe('success')
    expect(pool.acquire).toHaveBeenCalledOnce()
    service.setWindowOpen(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pool.acquire).toHaveBeenCalledTimes(2)
    expect(pool.acquire).toHaveBeenLastCalledWith('open', { signal: expect.any(AbortSignal), interaction: 'forbid' })
  })

  it('aborts an outstanding acquisition on service stop and never writes a late result', async () => {
    const service = create()
    pool.acquire.mockImplementationOnce((_hostId, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
    }))
    const pending = service.runBackground('closed')
    const signal = pool.acquire.mock.calls[0][1].signal as AbortSignal
    service.stop()
    expect(signal.aborted).toBe(true)
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'stopped' })
    expect(await service.runBackground('closed')).toMatchObject({ status: 'unavailable', reason: 'stopped' })
    expect(pool.acquire).toHaveBeenCalledOnce()
    expect(updated).not.toHaveBeenCalled()
  })
})

describe('retiring cached targets and collectors', () => {
  it.each(['old-first', 'new-first'] as const)('does not publish retired evidence or clear a newer pending collection (%s)', async order => {
    const service = create()
    await service.run('open')
    let oldFinish!: (value: HostSnapshot) => void, newFinish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve }))
    const old = service.runBackground('open'); await Promise.resolve()
    service.invalidate('open')
    expect(service.latest().open).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'snapshots.json'), 'utf8')).open).toBeUndefined()
    collect.mockImplementationOnce(() => new Promise(resolve => { newFinish = resolve }))
    const current = service.run('open'); await Promise.resolve()
    const next = snapshot(); next.collectedAt += 2000
    updated.mockClear()
    if (order === 'old-first') {
      oldFinish(snapshot())
      expect(await old).toMatchObject({ status: 'unavailable', reason: 'stopped', record: { snapshot: null, updatedAt: null } })
      expect(service.run('open')).toBe(current)
      expect(updated).not.toHaveBeenCalled()
      newFinish(next); await current
    } else {
      newFinish(next); await current
      oldFinish(snapshot())
      expect(await old).toMatchObject({ status: 'unavailable', reason: 'stopped', record: { snapshot: null, updatedAt: null } })
    }
    expect(updated).toHaveBeenCalledOnce()
    expect(service.latest().open.snapshot).toEqual(next)
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'snapshots.json'), 'utf8')).open.updatedAt).toBe(next.collectedAt)
    expect(pool.acquire).toHaveBeenCalledTimes(3)
  })

  it('allows a restored host ID to start immediately while its deleted generation is still finishing', async () => {
    const service = create()
    let oldFinish!: (value: HostSnapshot) => void, newFinish!: (value: HostSnapshot) => void
    collect.mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve }))
    const old = service.run('open'); await Promise.resolve()
    hosts = []; service.prune()
    hosts = [{ id: 'open' }]
    collect.mockImplementationOnce(() => new Promise(resolve => { newFinish = resolve }))
    const current = service.run('open'); await Promise.resolve()
    expect(current).not.toBe(old); expect(pool.acquire).toHaveBeenCalledTimes(2)
    oldFinish(snapshot()); expect((await old).snapshot).toBeNull()
    expect(service.run('open')).toBe(current)
    newFinish(snapshot()); await current
    expect(updated).toHaveBeenCalledOnce()
  })

  it('does not retry foreground authentication after its shared background attempt was invalidated', async () => {
    const service = create()
    let reject!: (error: Error) => void
    pool.acquire.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
    const background = service.runBackground('open'), manual = service.run('open')
    service.invalidate('open'); updated.mockClear()
    reject(new SshConnectionError('host-key', '主机指纹需要确认'))
    expect(await background).toMatchObject({ status: 'unavailable', reason: 'stopped', record: { snapshot: null } })
    expect((await manual).snapshot).toBeNull()
    expect(pool.acquire).toHaveBeenCalledOnce(); expect(updated).not.toHaveBeenCalled()
  })

  it('preserves aged history on read without starting a new connection or collection', async () => {
    const service = create(), before = await service.run('open')
    pool.acquire.mockClear(); collect.mockClear(); updated.mockClear()
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
    expect(service.latest().open).toEqual(before)
    expect(pool.acquire).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled(); expect(updated).not.toHaveBeenCalled()
  })
})
