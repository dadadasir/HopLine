import { expect, it, vi } from 'vitest'
const stats = await import(new URL('../scripts/perf-paired-stats.mjs', import.meta.url).href)
const runner = await import(new URL('../scripts/perf-paired.mjs', import.meta.url).href)
const GiB = 1024 ** 3, MiB = 1024 ** 2
const healthy = { totalBytes: 8 * GiB, availableBytes: 2 * GiB, swapUsedBytes: 5 * GiB, logicalCpus: 8, loadAverage: [4, 5, 4] }

it('retains negative paired differences and reports robust dispersion without mutating data', () => {
  const samples = [-10, 10, 30, 50, 1000].map(delta => ({ baseline: { coldStartMs: 100 }, application: { coldStartMs: 100 + delta } }))
  const before = JSON.stringify(samples), result = stats.summarizePairs(samples)
  expect(result).toMatchObject({ differencesMs: [-10, 10, 30, 50, 1000], count: 5, medianMs: 30, madMs: 20, q1Ms: 10, q3Ms: 50, iqrMs: 40, minMs: -10, maxMs: 1000, median95: null })
  expect(JSON.stringify(samples)).toBe(before)
  expect(stats.distribution([9, 1, 3, 7])).toMatchObject({ medianMs: 5, madMs: 3, q1Ms: 2.5, q3Ms: 7.5 })
})
it('computes exact binomial median intervals, not a normal approximation', () => {
  expect(stats.medianInterval([1, 2, 3, 4, 5, 6])).toMatchObject({ low: 1, high: 6 })
  expect(stats.medianInterval(Array.from({ length: 24 }, (_, i) => i + 1))).toMatchObject({ low: 7, high: 18 })
  expect(stats.distribution(Array(24).fill(200))).toMatchObject({ medianMs: 200, madMs: 0, iqrMs: 0, median95: { low: 200, high: 200 } })
})
it.each([[], [NaN], [Infinity]].map(values => ({ values })))('rejects unusable distributions $values', ({ values }) => { expect(() => stats.distribution(values)).toThrow() })
it.each([[], [{}], [{ baseline: { coldStartMs: 0 }, application: { coldStartMs: -1 } }], [{ baseline: { coldStartMs: Infinity }, application: { coldStartMs: 1 } }]].map(values => ({ values })))('rejects incomplete pairs $values', ({ values }) => { expect(() => stats.summarizePairs(values)).toThrow() })
it('accepts exact environment boundaries, including high historical swap below physical RAM', () => {
  expect(stats.assessEnvironment(healthy)).toEqual({ status: 'observational', reasons: [] })
  expect(stats.assessEnvironment({ ...healthy, availableBytes: 512 * MiB, swapUsedBytes: 8 * GiB, loadAverage: [8, 8, 99] }).status).toBe('observational')
})
it.each([
  { availableBytes: 512 * MiB - 1 }, { totalBytes: 64 * GiB, availableBytes: 3 * GiB },
  { swapUsedBytes: 8 * GiB + 1 }, { loadAverage: [8.001, 1, 1] }, { loadAverage: [1, 8.001, 1] },
  { availableBytes: NaN }, { availableBytes: 9 * GiB }, { swapUsedBytes: undefined }, { logicalCpus: 0 },
  { loadAverage: [0, 0] }, { loadAverage: [0, -1, 0] }, { error: '读取失败' }
])('marks the whole environment invalid: %s', change => {
  expect(stats.assessEnvironment({ ...healthy, ...change })).toMatchObject({ status: 'environment-invalid', reasons: [expect.any(String)] })
})
it('parses macOS reclaimable estimate, variable page size, and swap units without assuming raw free is available', () => {
  const memory = stats.parseMacMemory('Mach (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 30.\n', 'vm.swapusage: total = 6144.00M  used = 5028.75M  free = 1.00M (encrypted)')
  expect(memory.availableBytes).toBe(60 * 16384)
  expect(memory.swapUsedBytes).toBe(5028.75 * MiB)
  expect(stats.parseMacMemory('', '').availableBytes).toBeNaN()
  expect(stats.parseMacMemory('', 'used = 2.5G').swapUsedBytes).toBe(2.5 * GiB)
  expect(stats.parseLinuxMemory('MemAvailable: 1048576 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n')).toMatchObject({ availableBytes: GiB, swapUsedBytes: 60 * 1024 })
  expect(stats.assessEnvironment({ ...healthy, ...stats.parseLinuxMemory('') }).status).toBe('environment-invalid')
})
it('validates CLI pair counts and preserves the original command as a separate entry', () => {
  expect(runner.parsePairedArgs([]).pairs).toBe(24)
  expect(runner.parsePairedArgs(['--pairs', '6']).pairs).toBe(6)
  for (const args of [['--pairs', '5'], ['--pairs', '7'], ['--pairs', '101'], ['--pairs', '6.5'], ['--skip-budget'], ['--output'], ['--pairs', '6', '--pairs', '8']]) expect(() => runner.parsePairedArgs(args)).toThrow()
})
it('runs complete AB/BA pairs serially, associates measurements correctly, and keeps invalid samples', async () => {
  const calls: string[] = [], snapshots: unknown[] = []
  let active = false
  const measure = vi.fn(async (kind: string, index: number) => {
    expect(active).toBe(false); active = true; calls.push(kind)
    await Promise.resolve(); active = false
    return { coldStartMs: kind === 'baseline' ? 100 + index : 150 + index }
  })
  let reads = 0
  const environment = () => ({ ...healthy, ...(reads++ === 2 ? { swapUsedBytes: 9 * GiB } : {}) })
  const samples = await runner.collectPairs({ pairs: 6, measure, environment, onEnvironment: (snapshot: unknown) => snapshots.push(snapshot) })
  expect(calls).toEqual(['baseline', 'application', 'application', 'baseline', 'baseline', 'application', 'application', 'baseline', 'baseline', 'application', 'application', 'baseline'])
  expect(snapshots).toHaveLength(24)
  const report = runner.pairedReport(samples, snapshots)
  expect(runner.pairedReport(samples, []).status).toBe('environment-invalid')
  expect(report).toMatchObject({ count: 6, medianMs: 50, status: 'environment-invalid', byOrder: { baselineFirst: { count: 3, medianMs: 50 }, applicationFirst: { count: 3, medianMs: 50 } } })
})
it('stops on failed launches instead of manufacturing, retrying or dropping a pair', async () => {
  const measure = vi.fn().mockResolvedValueOnce({ coldStartMs: 100 }).mockRejectedValue(new Error('启动失败'))
  const onPair = vi.fn(), onMeasurement = vi.fn()
  await expect(runner.collectPairs({ pairs: 6, measure, environment: () => healthy, onPair, onMeasurement })).rejects.toThrow('启动失败')
  expect(measure).toHaveBeenCalledTimes(2); expect(onPair).not.toHaveBeenCalled()
  expect(onMeasurement).toHaveBeenCalledWith(expect.objectContaining({ index: 1, baseline: { coldStartMs: 100 } }))
})
