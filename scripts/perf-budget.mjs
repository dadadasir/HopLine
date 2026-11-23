import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 十进制 MB；renderer 基线 1,651,075 bytes，ceil(1.651075 × 1.25) = 3 MB。
// CI 完整产物基线（0.2.0）：mac arm64 zip 127,405,705 bytes，
// Linux AppImage 136,621,459 bytes；Windows x64 zip / NSIS exe 同量级上限。
const BUDGET_MB = { macZip: 140, winZip: 155, winExe: 130, appImage: 150, rendererJS: 3 }
// 冷启动时间、空闲内存见 scripts/perf-runtime.mjs（CI smoke job 里用 xvfb 测量）。
const root = fileURLToPath(new URL('..', import.meta.url))
let failed = false

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : []
  })
}

function check(label, bytes, budget) {
  const ok = bytes <= budget * 1_000_000
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${(bytes / 1_000_000).toFixed(3)} MB (${bytes} bytes) / ${budget} MB`)
  if (!ok) failed = true
}

function budgetForPackage(file) {
  if (file.endsWith('.AppImage')) return BUDGET_MB.appImage
  if (file.endsWith('.exe')) return BUDGET_MB.winExe
  if (file.includes('-win-')) return BUDGET_MB.winZip
  return BUDGET_MB.macZip
}

try {
  const renderer = join(root, 'out/renderer')
  const js = existsSync(renderer) ? files(renderer).filter((file) => /\.(?:js|mjs|cjs)$/.test(file)) : []
  if (!js.length) throw new Error('out/renderer 没有 JS 产物，请先执行 npm run build:unpack。')
  check('renderer 全部 JS（磁盘字节，非 gzip）', js.reduce((sum, file) => sum + statSync(file).size, 0), BUDGET_MB.rendererJS)

  const release = join(root, 'release')
  const packages = existsSync(release)
    ? readdirSync(release).filter((file) => /\.(zip|exe|AppImage)$/.test(file) && !file.includes('__uninstaller'))
    : []
  if (!packages.length) throw new Error('release/ 没有 zip 或 AppImage / exe 安装包，请先打包；不能将缺失产物视为通过。')
  for (const file of packages) {
    check(file, statSync(join(release, file)).size, budgetForPackage(file))
  }
} catch (error) {
  console.error(`FAIL ${error.message}`)
  failed = true
}
if (failed) process.exitCode = 1
