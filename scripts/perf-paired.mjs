import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureRun } from './perf-runtime.mjs'
import { ENVIRONMENT_POLICY, assessEnvironment, parseMacMemory, parseLinuxMemory, summarizePairs } from './perf-paired-stats.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
function command(file, args) { return execFileSync(file, args, { cwd: root, encoding: 'utf8', timeout: 5000 }).trim() }
export function readEnvironment() {
  const snapshot = { at: new Date().toISOString(), platform: platform(), totalBytes: totalmem(), logicalCpus: cpus().length, loadAverage: loadavg() }
  try {
    if (platform() === 'darwin') Object.assign(snapshot, parseMacMemory(command('/usr/bin/vm_stat', []), command('/usr/sbin/sysctl', ['vm.swapusage'])))
    else if (platform() === 'linux') Object.assign(snapshot, parseLinuxMemory(readFileSync('/proc/meminfo', 'utf8')))
    else snapshot.error = '此平台尚无可用内存/交换/负载采集支持'
  } catch (error) { snapshot.error = error.message }
  return { ...snapshot, assessment: assessEnvironment(snapshot) }
}
export function parsePairedArgs(args) {
  const options = { pairs: 24, output: join(tmpdir(), `hopline-perf-paired-${Date.now()}.json`) }
  const seen = new Set()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!['--pairs', '--output'].includes(key) || !value || seen.has(key)) throw new Error('参数：--pairs 偶数(6–100) --output 结果.json')
    seen.add(key)
    if (key === '--pairs') {
      if (!/^\d+$/.test(value) || Number(value) < 6 || Number(value) > 100 || Number(value) % 2) throw new Error('配对数须为 6–100 之间的偶数，以平衡启动顺序')
      options.pairs = Number(value)
    } else options.output = resolve(value)
  }
  return options
}
export function pairOrder(index) { return index % 2 ? ['application', 'baseline'] : ['baseline', 'application'] }
export async function collectPairs({ pairs, measure, environment = readEnvironment, onPair = () => {}, onEnvironment = () => {}, onMeasurement = () => {} }) {
  const samples = []
  for (let index = 0; index < pairs; index++) {
    const pair = { index: index + 1, order: pairOrder(index), environment: [] }
    for (const kind of pair.order) {
      const before = environment(); pair.environment.push(before); onEnvironment(before)
      pair[kind] = await measure(kind, index)
      await onMeasurement(pair)
      const after = environment(); pair.environment.push(after); onEnvironment(after)
    }
    pair.differenceMs = pair.application.coldStartMs - pair.baseline.coldStartMs
    samples.push(pair)
    await onPair(pair, samples)
  }
  return samples
}
export function pairedReport(samples, environment) {
  const reasons = environment.length ? [...new Set(environment.flatMap(snapshot => assessEnvironment(snapshot).reasons))] : ['环境遥测缺失']
  return { status: reasons.length ? 'environment-invalid' : 'observational', reasons, ...summarizePairs(samples),
    byOrder: Object.fromEntries(['baseline', 'application'].map(first => {
      const group = samples.filter(pair => pair.order[0] === first)
      return [first === 'baseline' ? 'baselineFirst' : 'applicationFirst', group.length ? summarizePairs(group) : null]
    })) }
}
export function artifactManifest(directory) {
  const result = {}
  function walk(relative = '') {
    for (const item of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, item.name)
      if (item.isDirectory()) walk(path)
      else if (item.isFile()) result[path] = createHash('sha256').update(readFileSync(join(directory, path))).digest('hex')
    }
  }
  walk()
  return result
}
const ms = value => value.toFixed(3)
export function printSummary(report) {
  console.log(`\n${report.status === 'environment-invalid' ? '环境无效（既不通过也不失败）' : '仅供观察（未设置增量关卡）'}`)
  for (const reason of report.reasons) console.log(`原因：${reason}`)
  console.log(`应用减基线：中位数 ${ms(report.medianMs)} ms；MAD ${ms(report.madMs)} ms；IQR ${ms(report.iqrMs)} ms；范围 ${ms(report.minMs)}～${ms(report.maxMs)} ms`)
  console.log(`基线/应用绝对中位数：${ms(report.baseline.medianMs)} / ${ms(report.application.medianMs)} ms（不判绝对预算）`)
  if (report.median95) console.log(`中位数 95% 描述区间：${ms(report.median95.low)}～${ms(report.median95.high)} ms（独立同分布假设；相关噪声会降低可信度）`)
  for (const [order, summary] of Object.entries(report.byOrder)) if (summary) console.log(`${order === 'baselineFirst' ? '基线先启动' : '应用先启动'}：${summary.count} 对，中位数 ${ms(summary.medianMs)} ms`)
}
export async function main(options) {
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), requestedPairs: options.pairs, policy: ENVIRONMENT_POLICY,
    endpoint: '父进程启动 → 目录状态就绪 → 原双 requestAnimationFrame → 原首屏 IPC；基线使用已就绪空文档',
    notes: '新进程/新资料；非清空磁盘缓存；基线差值含业务及不同窗口路径，不能等同纯业务 CPU 时间。', samples: [], environment: [] }
  const save = () => writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  try {
    if (!['main/index.js', 'preload/index.js', 'renderer/index.html'].every(file => existsSync(join(root, 'out', file)))) throw new Error('构建产物缺失，请先执行 npm run build:unpack。')
    report.machine = { platform: platform(), release: release(), arch: process.arch, node: process.version, electron: require('electron/package.json').version }
    report.source = { head: command('git', ['rev-parse', 'HEAD']), main: command('git', ['rev-parse', 'main']), changes: command('git', ['status', '--short']) }
    report.artifacts = artifactManifest(join(root, 'out'))
    report.baselineArtifacts = artifactManifest(join(root, 'scripts/perf-baseline'))
    const initial = readEnvironment(); report.environment.push(initial)
    console.log(`环境：可用估计 ${(initial.availableBytes / 1024 ** 2).toFixed(1)} MiB；交换 ${(initial.swapUsedBytes / 1024 ** 3).toFixed(2)} GiB；负载 ${initial.loadAverage.join(' / ')}；${initial.logicalCpus} 逻辑核`)
    for (const reason of initial.assessment.reasons) console.log(`环境无效：${reason}；仍记录原始数字，不参与通过/失败判定。`)
    console.log(`交替配平 ${options.pairs} 对；每次保留原 10 秒空闲/60 秒超时。结果：${options.output}`)
    save()
    const executable = require('electron')
    await collectPairs({ pairs: options.pairs,
      measure: kind => measureRun(executable, [kind === 'baseline' ? join(root, 'scripts/perf-baseline/main.cjs') : root]),
      onEnvironment: snapshot => report.environment.push(snapshot),
      onMeasurement: pair => { report.incompletePair = pair; save() },
      onPair: (pair, samples) => {
        report.samples = [...samples]
        delete report.incompletePair
        console.log(`配对 ${pair.index}（${pair.order[0] === 'baseline' ? '基线→应用' : '应用→基线'}）：基线 ${ms(pair.baseline.coldStartMs)} ms；应用 ${ms(pair.application.coldStartMs)} ms；差值 ${ms(pair.differenceMs)} ms`)
        save()
      } })
    if (JSON.stringify(report.artifacts) !== JSON.stringify(artifactManifest(join(root, 'out')))) throw new Error('测量期间构建产物发生变化，结果不可比较')
    if (JSON.stringify(report.baselineArtifacts) !== JSON.stringify(artifactManifest(join(root, 'scripts/perf-baseline')))) throw new Error('测量期间基线文件发生变化，结果不可比较')
    report.summary = pairedReport(report.samples, report.environment)
    report.finishedAt = new Date().toISOString()
    save(); printSummary(report.summary)
    // Environment invalid is neither a pass nor a performance failure. Only an
    // execution error returns nonzero. Consumers must inspect summary.status.
    return 0
  } catch (error) {
    report.error = error.message; report.finishedAt = new Date().toISOString()
    try { save() } catch { /* The output error remains visible below. */ }
    console.error(`测量未完成：${error.message}`)
    return 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(parsePairedArgs(process.argv.slice(2))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
