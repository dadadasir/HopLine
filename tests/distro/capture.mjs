import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const [probe, ...extra] = process.argv.slice(2)
if (!probe || extra.length || !/^[a-z][a-z0-9-]*$/.test(probe)) {
  console.error('用法：npm run distro:capture -- <探测脚本名>，例如 basic（不含 .sh）')
  process.exit(1)
}
const require = createRequire(import.meta.url)
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const child = spawn(process.execPath, [vitest, 'run', '-c', 'vitest.distro.config.ts', 'tests/distro/capture.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, HOPLINE_CAPTURE_PROBE: probe }
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.on('error', (error) => { console.error(`采集进程启动失败：${error.message}`); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143) })
