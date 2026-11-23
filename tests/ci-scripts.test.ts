import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopline-ci-'))
  mkdirSync(join(root, 'scripts'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function file(name: string, contents = '') {
  const target = join(root, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
  return target
}

function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, 'scripts', script))
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOPLINE_EDITION: 'community', HOPLINE_PRO_DIR: '', ...env }
  })
}

describe('性能预算 CLI', () => {
  it('递归累计 JS，忽略 CSS 和 sourcemap，并接受恰好达到上限的产物', () => {
    truncateSync(file('out/renderer/main.js'), 2_000_000)
    truncateSync(file('out/renderer/assets/lazy.mjs'), 1_000_000)
    truncateSync(file('out/renderer/assets/main.js.map'), 5_000_000)
    truncateSync(file('out/renderer/assets/style.css'), 5_000_000)
    truncateSync(file('release/Hopline-mac-arm64.zip'), 140_000_000)
    truncateSync(file('release/Hopline-linux-x64.AppImage'), 150_000_000)
    const result = run('perf-budget.mjs')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('3000000 bytes')
  })

  it.each([
    ['out/renderer/main.js', 3_000_001],
    ['release/Hopline-mac-x64.zip', 140_000_001],
    ['release/Hopline-linux-x64.AppImage', 150_000_001]
  ])('超限一字节即失败：%s', (name, bytes) => {
    file('out/renderer/main.js', 'ok')
    file('release/Hopline-mac-arm64.zip', 'ok')
    truncateSync(file(name), bytes as number)
    const result = run('perf-budget.mjs')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL')
  })

  it('缺失 JS 或安装包时失败，不产生假通过', () => {
    expect(run('perf-budget.mjs').status).toBe(1)
    file('out/renderer/main.js', 'ok')
    const result = run('perf-budget.mjs')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('没有 zip 或 AppImage')
  })
})

describe('打包参数 CLI', () => {
  beforeEach(() => {
    file('scripts/check-edition.mjs', 'export function checkEdition() {}')
    for (const name of ['electron-vite', 'electron-builder']) {
      file(`node_modules/${name}/package.json`, JSON.stringify({ name, bin: 'cli.cjs' }))
      file(`node_modules/${name}/cli.cjs`, `require('node:fs').writeFileSync('${name}.json', JSON.stringify({args: process.argv.slice(2), edition: process.env.HOPLINE_EDITION}))`)
    }
  })

  it('将 -- 后的参数原样传给 electron-builder，包括带空格的参数', () => {
    const args = ['--linux', '--x64', '--publish', 'never', '--config.productName=Hopline Test']
    expect(run('build-edition.mjs', ['community', '--package', '--', ...args]).status).toBe(0)
    expect(JSON.parse(readFileSync(join(root, 'electron-builder.json'), 'utf8'))).toEqual({ args, edition: 'community' })
  })

  it('在本机使用对应平台的默认打包参数', () => {
    const result = run('build-edition.mjs', ['community', '--package'])
    if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
      expect(result.status).toBe(1)
      return
    }
    expect(result.status).toBe(0)
    const expected = process.platform === 'darwin'
      ? ['--mac', '--arm64']
      : process.platform === 'win32'
        ? ['--win', '--x64']
        : ['--linux']
    expect(JSON.parse(readFileSync(join(root, 'electron-builder.json'), 'utf8')).args).toEqual(expected)
  })

  it('拒绝用软链接依赖打包，保留现有构建，但仍允许开发构建', () => {
    renameSync(join(root, 'node_modules'), join(root, 'dependencies'))
    symlinkSync(join(root, 'dependencies'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    file('out/keep.txt', 'keep')
    const result = run('build-edition.mjs', ['community', '--package'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('软链接')
    expect(readFileSync(join(root, 'out/keep.txt'), 'utf8')).toBe('keep')
    expect(run('build-edition.mjs', ['community']).status).toBe(0)
  })

  it('缺失 pro 仓库时提前失败，保留已有产物', () => {
    file('out/keep.txt', 'keep')
    const result = run('build-edition.mjs', ['pro', '--package'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('HOPLINE_PRO_DIR')
    expect(readFileSync(join(root, 'out/keep.txt'), 'utf8')).toBe('keep')
  })
})
