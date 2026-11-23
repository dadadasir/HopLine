import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: mock.spawn
}))
const script = new URL('../scripts/perf-runtime.mjs', import.meta.url).href
const { BUDGET, parsePerfLine, parsePerfStageLine, parseRuntimeArgs, summarize, checkBudget, measureRun, main } = await import(script)
const metrics = { coldStartMs: 80, firstPaintMs: 60, idleMemoryMB: 100 }
const report = `HOPLINE_PERF ${JSON.stringify(metrics)}`
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  mock.spawn.mockReset().mockReturnValue(child)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('parses metrics while ignoring unrelated output and the first-paint marker', () => {
  expect(['noise', 'HOPLINE_PERF_FIRST_PAINT', report, 'trailing noise'].map(parsePerfLine).filter(Boolean)).toEqual([metrics])
})

it('parses only explicit diagnostic stages and does not confuse them with metrics', () => {
  const line = 'HOPLINE_PERF_STAGE {"name":"catalog-ready","uptimeMs":123.5}'
  expect(parsePerfStageLine(line)).toEqual({ name: 'catalog-ready', uptimeMs: 123.5 })
  expect(parsePerfLine(line)).toBeNull()
  expect(parsePerfStageLine(report)).toBeNull()
  expect(parseRuntimeArgs([])).toEqual({ trace: false })
  expect(parseRuntimeArgs(['--trace'])).toEqual({ trace: true })
  expect(() => parseRuntimeArgs(['--skip-budget'])).toThrow('未知参数')
})

it.each(['{}', 'null', '{', '{"name":"catalog-ready","uptimeMs":-1}',
  '{"name":"catalog-ready","uptimeMs":1e999}', '{"name":"catalog-ready","uptimeMs":"1"}',
  '{"name":"arbitrary\\npayload","uptimeMs":1}', '{"name":"catalog-ready","uptimeMs":1,"extra":"data"}'
])('rejects malformed stage diagnostics: %s', json => {
  expect(() => parsePerfStageLine(`HOPLINE_PERF_STAGE ${json}`)).toThrow()
})

it.each([
  '{}', 'null', '{', '{"coldStartMs":1,"firstPaintMs":2}',
  '{"coldStartMs":"1","firstPaintMs":2,"idleMemoryMB":3}',
  '{"coldStartMs":-1,"firstPaintMs":2,"idleMemoryMB":3}',
  '{"coldStartMs":1e999,"firstPaintMs":2,"idleMemoryMB":3}'
])('rejects missing, malformed or invalid metrics: %s', (json) => {
  expect(() => parsePerfLine(`HOPLINE_PERF ${json}`)).toThrow()
})

it('takes the numerical median and maximum without changing the samples', () => {
  const samples = [100, 20, 3].map((coldStartMs, i) => ({ coldStartMs, idleMemoryMB: [90, 120, 100][i] }))
  expect(summarize(samples)).toEqual({ coldStartMs: 20, idleMemoryMB: 120 })
  expect(samples.map((sample) => sample.coldStartMs)).toEqual([100, 20, 3])
  expect(() => summarize(samples.slice(1))).toThrow('3')
})

it('accepts the exact budget and rejects either exceeded budget', () => {
  const { coldStartMs, idleMemoryMB } = BUDGET
  expect(checkBudget({ coldStartMs, idleMemoryMB })).toBe(0)
  for (const result of [{ coldStartMs: coldStartMs + 0.01, idleMemoryMB }, { coldStartMs, idleMemoryMB: idleMemoryMB + 0.01 }]) {
    expect(checkBudget(result)).toBe(1)
  }
  expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^FAIL coldStartMs:/))
  expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^FAIL idleMemoryMB:/))
})

it('uses spawn-to-marker time, handles fragmented lines and removes its isolated profile', async () => {
  vi.stubEnv('HOPLINE_USER_DATA', '/must-not-use')
  vi.stubEnv('HOPLINE_DEMO', '1')
  vi.stubEnv('HOPLINE_SMOKE', '1')
  vi.stubEnv('HOPLINE_SHOTS', '1')
  vi.stubEnv('ELECTRON_RENDERER_URL', 'https://must-not-use.test')
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  const result = measureRun('fake-electron')
  const options = mock.spawn.mock.calls[0][2]
  const profile = options.env.HOPLINE_USER_DATA
  expect(existsSync(profile)).toBe(true)
  expect(profile).not.toBe('/must-not-use')
  expect(options.env.HOPLINE_PERF).toBe('1')
  expect(options.env.HOPLINE_DISABLE_KEYSTORE).toBe('1')
  for (const key of ['HOPLINE_DEMO', 'HOPLINE_SMOKE', 'HOPLINE_SHOTS', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) {
    expect(options.env[key]).toBeUndefined()
  }
  expect(mock.spawn.mock.calls[0][1]).toEqual([options.cwd])
  child.stdout.write('unrelated\nHOPLINE_PERF_FIRST_')
  vi.advanceTimersByTime(120)
  child.stdout.write('PAINT\r\nmore noise\n')
  vi.advanceTimersByTime(10_000)
  child.stdout.write(report.slice(0, 20))
  child.stderr.write('harmless stderr\n')
  child.stdout.write(report.slice(20))
  child.emit('close', 0, null)
  await expect(result).resolves.toEqual({ ...metrics, coldStartMs: 120, mainColdStartMs: 80 })
  expect(existsSync(profile)).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('collects optional trace stages without changing the spawn-to-original-marker measurement', async () => {
  const args = ['application'], result = measureRun('fake-electron', args, { trace: true })
  expect(mock.spawn.mock.calls[0][1]).toEqual(['application', '--hopline-perf-trace'])
  expect(args).toEqual(['application'])
  expect(mock.spawn.mock.calls[0][2].env.HOPLINE_PERF).toBe('1')
  child.stdout.write('HOPLINE_PERF_STAGE {"name":"main-entry","uptimeMs":40}\n')
  vi.advanceTimersByTime(90)
  child.stdout.write('HOPLINE_PERF_STAGE {"name":"renderer-entry","uptimeMs":60}\n')
  vi.advanceTimersByTime(30)
  child.stdout.write('HOPLINE_PERF_STAGE {"name":"catalog-ready","uptimeMs":70}\nHOPLINE_PERF_FIRST_PAINT\n')
  expect(console.log).not.toHaveBeenCalled()
  vi.advanceTimersByTime(10_000)
  child.stdout.write(`${report}\n`); child.emit('close', 0, null)
  await expect(result).resolves.toEqual({ ...metrics, coldStartMs: 120, mainColdStartMs: 80, stages: [
    { name: 'main-entry', uptimeMs: 40 }, { name: 'renderer-entry', uptimeMs: 60 }, { name: 'catalog-ready', uptimeMs: 70 }
  ] })
})

it('never treats trace stages as a replacement for the original first-paint marker', async () => {
  const result = measureRun('fake-electron', [], { trace: true })
  const rejected = expect(result).rejects.toThrow('首屏标记缺失')
  child.stdout.write(`HOPLINE_PERF_STAGE {"name":"first-paint","uptimeMs":1}\n${report}\n`)
  await rejected
})

it.each([false, true])('times out at 60 seconds even with a complete report: %s', async (reported) => {
  Object.assign(child, { pid: 12345 })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const result = measureRun('fake-electron')
  const rejected = expect(result).rejects.toThrow('超时（60 秒）')
  const profile = mock.spawn.mock.calls[0][2].env.HOPLINE_USER_DATA
  if (reported) child.stdout.write(`HOPLINE_PERF_FIRST_PAINT\n${report}\n`)
  vi.advanceTimersByTime(59_999)
  expect(kill).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  await rejected
  if (process.platform === 'win32') expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  else expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
  expect(existsSync(profile)).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['no output', '', 0],
  ['missing first paint', `${report}\n`, 0],
  ['malformed metrics', 'HOPLINE_PERF_FIRST_PAINT\nHOPLINE_PERF {}\n', 0],
  ['duplicate metrics', `HOPLINE_PERF_FIRST_PAINT\n${report}\n${report}\n`, 0],
  ['nonzero exit', `HOPLINE_PERF_FIRST_PAINT\n${report}\n`, 1]
])('rejects %s and cleans up', async (_label, output, code) => {
  const result = measureRun('fake-electron')
  const rejected = expect(result).rejects.toThrow()
  const profile = mock.spawn.mock.calls[0][2].env.HOPLINE_USER_DATA
  child.stdout.write(output)
  child.emit('close', code, null)
  await rejected
  expect(existsSync(profile)).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('reports spawn failure with captured diagnostics', async () => {
  const result = measureRun('missing-electron')
  const rejected = expect(result).rejects.toThrow(/ENOENT\nfailure detail/)
  const profile = mock.spawn.mock.calls[0][2].env.HOPLINE_USER_DATA
  child.stderr.write('failure detail')
  child.emit('error', new Error('ENOENT'))
  await rejected
  expect(existsSync(profile)).toBe(false)
})

it('runs three samples sequentially and reports failure without continuing after an error', async () => {
  let active = false, count = 0
  const measure = vi.fn(async () => {
    expect(active).toBe(false)
    active = true
    await Promise.resolve()
    active = false
    count++
    return { ...metrics, coldStartMs: [0, 7000, 8000, 10][count], mainColdStartMs: 80 }
  })
  expect(await main(measure)).toBe(1)
  expect(measure).toHaveBeenCalledTimes(3)
  const failed = vi.fn().mockRejectedValue(new Error('测量失败'))
  expect(await main(failed)).toBe(1)
  expect(failed).toHaveBeenCalledTimes(1)
  expect(console.error).toHaveBeenCalledWith('FAIL 测量失败')
})

it('prints trace deltas after each completed sample while applying the same three-run budget', async () => {
  const measure = vi.fn(async () => ({ ...metrics, coldStartMs: BUDGET.coldStartMs + 1, mainColdStartMs: 80,
    stages: [{ name: 'main-entry', uptimeMs: 30 }, { name: 'catalog-ready', uptimeMs: 75 }] }))
  expect(await main(measure, { trace: true })).toBe(1)
  expect(measure).toHaveBeenCalledTimes(3)
  expect(console.log).toHaveBeenCalledWith('Trace 1: main-entry uptimeMs=30.000, deltaMs=30.000')
  expect(console.log).toHaveBeenCalledWith('Trace 3: catalog-ready uptimeMs=75.000, deltaMs=45.000')
  expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^FAIL coldStartMs:/))
})

it('propagates the budget result to an actual Node exit code', () => {
  for (const [coldStartMs, expected] of [[10, 0], [5001, 1]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { main } from ${JSON.stringify(script)}; process.exitCode = await main(async () => (${JSON.stringify({ ...metrics, coldStartMs, mainColdStartMs: 80 })}))`
    ], { encoding: 'utf8' })
    expect(result.status).toBe(expected)
    expect(result.stdout).toContain(`${expected ? 'FAIL' : 'PASS'} coldStartMs:`)
  }
})
