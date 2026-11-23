import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 基线（2026-10-28，0.3.0）：macOS arm64 本机冷启动 301 ms、内存 383 MiB；
// CI Linux（xvfb，GPU 走软件渲染）冷启动 746 ms、内存 595 MiB。上限取基线 × 1.5 向上取整。内存 MB 指 MiB。
const BUDGETS = {
  darwin: { coldStartMs: 500, idleMemoryMB: 600 },
  win32: { coldStartMs: 900, idleMemoryMB: 750 },
  linux: { coldStartMs: 1200, idleMemoryMB: 900 }
}
export const BUDGET = BUDGETS[process.platform] ?? BUDGETS.linux
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

export function parsePerfLine(line) {
  if (!line.startsWith('HOPLINE_PERF ')) return null
  const value = JSON.parse(line.slice('HOPLINE_PERF '.length))
  if (!value || ['coldStartMs', 'firstPaintMs', 'idleMemoryMB'].some((key) =>
    typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) {
    throw new Error('HOPLINE_PERF 字段缺失或无效')
  }
  return value
}

export function parsePerfStageLine(line) {
  if (!line.startsWith('HOPLINE_PERF_STAGE ')) return null
  const value = JSON.parse(line.slice('HOPLINE_PERF_STAGE '.length))
  if (!value || typeof value.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.name) ||
      typeof value.uptimeMs !== 'number' || !Number.isFinite(value.uptimeMs) || value.uptimeMs < 0 ||
      Object.keys(value).some(key => key !== 'name' && key !== 'uptimeMs')) {
    throw new Error('HOPLINE_PERF_STAGE 字段缺失或无效')
  }
  return value
}

export function parseRuntimeArgs(args) {
  if (args.some(arg => arg !== '--trace')) throw new Error('未知参数；性能诊断仅支持 --trace')
  return { trace: args.includes('--trace') }
}

export function summarize(samples) {
  if (samples.length !== 3) throw new Error('需要 3 次完整测量')
  return {
    coldStartMs: samples.map((sample) => sample.coldStartMs).sort((a, b) => a - b)[1],
    idleMemoryMB: Math.max(...samples.map((sample) => sample.idleMemoryMB))
  }
}

export function checkBudget(result, budget = BUDGET) {
  let failed = false
  for (const [key, unit] of [['coldStartMs', 'ms'], ['idleMemoryMB', 'MB']]) {
    const ok = Number.isFinite(result[key]) && result[key] >= 0 && result[key] <= budget[key]
    console.log(`${ok ? 'PASS' : 'FAIL'} ${key}: ${result[key].toFixed(3)} ${unit} / ${budget[key]} ${unit}`)
    if (!ok) failed = true
  }
  return failed ? 1 : 0
}

export async function measureRun(executable, args = [root], { trace = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'hopline-perf-'))
  try {
    return await new Promise((resolveRun, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('HOPLINE_') && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key)))
      const startedAt = performance.now()
      const child = spawn(executable, trace ? [...args, '--hopline-perf-trace'] : args, {
        cwd: root, env: { ...env, HOPLINE_PERF: '1', HOPLINE_USER_DATA: profile, HOPLINE_DISABLE_UPDATE_CHECK: '1', HOPLINE_DISABLE_FX_CHECK: '1', HOPLINE_DISABLE_KEYSTORE: '1' },
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      })
      let pending = '', diagnostic = '', coldStartMs, metrics, done = false
      const stages = []
      const finish = (error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (error) {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch { /* Already exited. */ }
          reject(new Error(`${error.message}\n${diagnostic}`))
        } else resolveRun({ ...metrics, mainColdStartMs: metrics.coldStartMs, coldStartMs, ...(trace ? { stages } : {}) })
      }
      const timer = setTimeout(() => finish(new Error('性能测量超时（60 秒），已终止子进程')), 60_000)
      const readLine = (line) => {
        if (line === 'HOPLINE_PERF_FIRST_PAINT' && coldStartMs === undefined) coldStartMs = performance.now() - startedAt
        if (trace) {
          const stage = parsePerfStageLine(line)
          if (stage) {
            if (stages.length >= 256) throw new Error('性能阶段记录过多')
            stages.push(stage)
          }
        }
        const parsed = parsePerfLine(line)
        if (parsed) {
          if (coldStartMs === undefined || metrics) throw new Error('首屏标记缺失或性能结果重复')
          metrics = parsed
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (data) => {
        diagnostic = (diagnostic + data).slice(-4000)
        pending += data
        try {
          let end
          while ((end = pending.indexOf('\n')) !== -1) {
            readLine(pending.slice(0, end).replace(/\r$/, ''))
            pending = pending.slice(end + 1)
          }
          if (pending.length > 65536) throw new Error('子进程输出行过长')
        } catch (error) { finish(error) }
      })
      child.stderr.on('data', (data) => { diagnostic = (diagnostic + data).slice(-4000) })
      child.once('error', finish)
      child.once('close', (code, signal) => {
        try {
          if (pending) readLine(pending.replace(/\r$/, ''))
          if (code !== 0 || !metrics) throw new Error(`子进程退出（code=${code}, signal=${signal}），未完成有效测量`)
          finish()
        } catch (error) { finish(error) }
      })
    })
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}

export async function main(measure, { trace = false } = {}) {
  try {
    const run = measure ?? (() => measureRun(require('electron'), [root], { trace }))
    const samples = []
    for (let i = 0; i < 3; i++) {
      const sample = await run()
      console.log(`Run ${i + 1}: coldStartMs=${sample.coldStartMs.toFixed(3)}, idleMemoryMB=${sample.idleMemoryMB.toFixed(3)}; main reference: coldStartMs=${sample.mainColdStartMs}, firstPaintMs=${sample.firstPaintMs}`)
      // Print only after the child exits, so trace presentation cannot delay
      // receipt of the original FIRST_PAINT marker in the parent process.
      if (trace) {
        let previous = 0
        for (const stage of sample.stages ?? []) {
          console.log(`Trace ${i + 1}: ${stage.name} uptimeMs=${stage.uptimeMs.toFixed(3)}, deltaMs=${(stage.uptimeMs - previous).toFixed(3)}`)
          previous = stage.uptimeMs
        }
      }
      samples.push(sample)
    }
    return checkBudget(summarize(samples))
  } catch (error) {
    console.error(`FAIL ${error.message}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRuntimeArgs(process.argv.slice(2))
    if (!['main/index.js', 'preload/index.js', 'renderer/index.html'].every((file) => existsSync(join(root, 'out', file)))) {
      throw new Error('构建产物缺失，请先执行 npm run build:unpack。')
    }
    process.exitCode = await main(undefined, options)
  } catch (error) {
    console.error(`FAIL ${error.message}`)
    process.exitCode = 1
  }
}
