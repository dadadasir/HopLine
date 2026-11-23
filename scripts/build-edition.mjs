import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkEdition } from './check-edition.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const options = separator === -1 ? args : args.slice(0, separator)
const extraArgs = separator === -1 ? [] : args.slice(separator + 1)
const edition = options[0]?.startsWith('--') || !options[0]
  ? process.env.HOPLINE_EDITION ?? 'community' : options[0]
if (edition !== 'community' && edition !== 'pro') {
  console.error('HOPLINE_EDITION 必须为 community 或 pro / Expected community or pro')
  process.exit(1)
}
if (edition === 'pro' && (!process.env.HOPLINE_PRO_DIR ||
  !['main/index.ts', 'renderer/index.ts'].every((file) => existsSync(resolve(root, process.env.HOPLINE_PRO_DIR, file))))) {
  console.error('Pro 扩展未提供。请将 HOPLINE_PRO_DIR 指向包含 main/index.ts 和 renderer/index.ts 的扩展目录。')
  process.exit(1)
}
const packageArgs = extraArgs.length ? extraArgs
  : process.platform === 'darwin' ? ['--mac', '--arm64']
    : process.platform === 'linux' ? ['--linux']
      : process.platform === 'win32' ? ['--win', '--x64'] : undefined
if (options.includes('--package') && !packageArgs) {
  console.error('当前平台没有默认打包目标，请在 -- 后提供 electron-builder 参数。')
  process.exit(1)
}
// electron-builder can miss transitive modules when the entire dependency tree is a symlink.
if (options.includes('--package') && lstatSync(resolve(root, 'node_modules')).isSymbolicLink()) {
  console.error('打包需要真实的 node_modules 目录，不能使用整个目录的软链接。请在当前检出目录准备已有依赖的独立副本后重试；开发运行不受影响。')
  process.exit(1)
}
const env = { ...process.env, HOPLINE_EDITION: edition }
function runPackage(name, args) {
  const packageFile = require.resolve(`${name}/package.json`)
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name]
  const result = spawnSync(process.execPath, [resolve(dirname(packageFile), bin), ...args], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Clean all targets together so no previous edition or stale chunks survive.
rmSync(resolve(root, 'out'), { recursive: true, force: true })
runPackage('electron-vite', ['build'])
if (edition === 'community') checkEdition()
if (options.includes('--package')) {
  const crossWin = packageArgs.includes('--win') && process.platform !== 'win32' &&
    !packageArgs.some((arg) => arg.includes('npmRebuild'))
  runPackage('electron-builder', crossWin ? [...packageArgs, '-c.npmRebuild=false'] : packageArgs)
}
