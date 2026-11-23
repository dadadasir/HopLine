// Pure statistics and telemetry policy; these are observation rules, not startup budgets.
const MiB = 1024 ** 2
export const ENVIRONMENT_POLICY = Object.freeze({ minAvailableBytes: 512 * MiB, minAvailableRatio: 0.05, maxSwapRatio: 1, maxLoadPerCore: 1 })

function numbers(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('统计需要非空、有限数值样本')
  return [...values].sort((a, b) => a - b)
}
export function quantile(values, p) {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('分位数必须在 0–1 之间')
  const sorted = numbers(values), index = (sorted.length - 1) * p, lo = Math.floor(index)
  return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo)
}
// Distribution-free two-sided interval from binomial order statistics (>=95%
// coverage under independent, identically distributed continuous observations).
// It is descriptive when adjacent samples are correlated; never a gate.
export function medianInterval(values) {
  const sorted = numbers(values), n = sorted.length
  let probability = 2 ** -n, tail = probability, k = 0
  for (let candidate = 1; candidate <= Math.floor(n / 2); candidate++) {
    if (tail > 0.025) break
    k = candidate
    probability *= (n - candidate + 1) / candidate
    tail += probability
  }
  return k ? { low: sorted[k - 1], high: sorted[n - k], confidence: 0.95, method: 'binomial-order-statistics' } : null
}
export function distribution(values) {
  const medianMs = quantile(values, 0.5), q1Ms = quantile(values, 0.25), q3Ms = quantile(values, 0.75)
  return { count: values.length, medianMs, madMs: quantile(values.map(value => Math.abs(value - medianMs)), 0.5),
    q1Ms, q3Ms, iqrMs: q3Ms - q1Ms, minMs: Math.min(...values), maxMs: Math.max(...values), median95: medianInterval(values) }
}
export function summarizePairs(pairs) {
  if (!pairs.length) throw new Error('需要完整配对样本')
  const differences = pairs.map(pair => {
    if (![pair.baseline?.coldStartMs, pair.application?.coldStartMs].every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error('基线或应用样本缺失、无效')
    }
    return pair.application.coldStartMs - pair.baseline.coldStartMs
  })
  return { differencesMs: differences, ...distribution(differences),
    baseline: distribution(pairs.map(pair => pair.baseline.coldStartMs)),
    application: distribution(pairs.map(pair => pair.application.coldStartMs)) }
}
export function assessEnvironment(snapshot) {
  const reasons = []
  const { totalBytes, availableBytes, swapUsedBytes, logicalCpus, loadAverage } = snapshot
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(availableBytes) || availableBytes < 0 || availableBytes > totalBytes ||
      !Number.isFinite(swapUsedBytes) || swapUsedBytes < 0 || !Number.isInteger(logicalCpus) || logicalCpus < 1 ||
      !Array.isArray(loadAverage) || loadAverage.length !== 3 || loadAverage.some(value => !Number.isFinite(value) || value < 0) || snapshot.error) {
    reasons.push(`环境遥测不完整${snapshot.error ? `：${snapshot.error}` : ''}`)
  } else {
    if (availableBytes < Math.max(ENVIRONMENT_POLICY.minAvailableBytes, totalBytes * ENVIRONMENT_POLICY.minAvailableRatio)) reasons.push('可用内存低于 512 MiB 或物理内存的 5%')
    if (swapUsedBytes > totalBytes * ENVIRONMENT_POLICY.maxSwapRatio) reasons.push('交换占用超过物理内存（历史高压力诊断范围）')
    if (Math.max(loadAverage[0], loadAverage[1]) / logicalCpus > ENVIRONMENT_POLICY.maxLoadPerCore) reasons.push('1 或 5 分钟平均负载超过逻辑 CPU 数')
  }
  return { status: reasons.length ? 'environment-invalid' : 'observational', reasons }
}
export function parseMacMemory(vmstat, swapusage) {
  const pageSize = Number(vmstat.match(/page size of (\d+) bytes/)?.[1])
  const pages = name => Number(vmstat.match(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm'))?.[1])
  const swap = swapusage.match(/used\s*=\s*([\d.]+)([KMGT])(?:\s|$)/)
  return { availableBytes: (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize,
    swapUsedBytes: swap ? Number(swap[1]) * 1024 ** ('KMGT'.indexOf(swap[2]) + 1) : NaN,
    availableMethod: 'vm_stat: free + inactive + speculative（可回收估计）' }
}
export function parseLinuxMemory(meminfo) {
  const field = name => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))?.[1]) * 1024
  return { availableBytes: field('MemAvailable'), swapUsedBytes: field('SwapTotal') - field('SwapFree'), availableMethod: '/proc/meminfo: MemAvailable' }
}
