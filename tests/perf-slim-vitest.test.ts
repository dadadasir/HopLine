import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../vitest.config'
import { getLoadedSodium, getSodium } from '../src/core/sodium'
import { translate } from '../src/renderer/src/i18n'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml')

function listTestFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...listTestFiles(full))
    else if (entry.name.endsWith('.test.ts')) results.push(full.split(path.sep).join('/'))
  }
  return results.filter((file) => !file.startsWith('tests/distro/')).sort()
}

function matchesPattern(file: string, pattern: string): boolean {
  if (pattern === 'tests/**/*.test.ts') return file.startsWith('tests/') && file.endsWith('.test.ts')
  if (pattern === 'tests/distro/**') return file.startsWith('tests/distro/')
  if (pattern === 'tests/*-live.test.ts') return /^tests\/[^/]+-live\.test\.ts$/.test(file)
  return file === pattern
}

describe('Vitest dual-pool partition', () => {
  it('routes every non-distro test file to exactly one pool and isolates all child-process / loopback suites', () => {
    const projects = vitestConfig.test?.projects as Array<{
      test: {
        name: string
        pool: string
        maxWorkers?: number
        sequence?: { groupOrder?: number }
        include: string[]
        exclude: string[]
      }
    }>
    expect(projects).toHaveLength(2)
    const [unit, subprocess] = projects
    expect(unit!.test).toMatchObject({ name: 'unit', pool: 'threads', sequence: { groupOrder: 0 } })
    expect(subprocess!.test).toMatchObject({ name: 'subprocess', pool: 'forks', maxWorkers: 2, sequence: { groupOrder: 1 } })

    const allFiles = listTestFiles('tests')
    expect(allFiles.length).toBeGreaterThanOrEqual(174)

    const resolvePool = (project: typeof unit) =>
      allFiles.filter((file) =>
        project!.test.include.some((p) => matchesPattern(file, p)) &&
        !project!.test.exclude.some((p) => matchesPattern(file, p))
      )

    const unitFiles = resolvePool(unit)
    const subprocessFiles = resolvePool(subprocess)
    const overlap = unitFiles.filter((file) => subprocessFiles.includes(file))
    expect(overlap).toEqual([])
    expect([...unitFiles, ...subprocessFiles].sort()).toEqual(allFiles)

    const subprocessImport = /^import\b.*(?:node:child_process|mini-sshd|mini-agent|atomic-edit-python|['"]node-pty['"])/m
    for (const file of unitFiles) {
      const source = fs.readFileSync(file, 'utf8')
      expect(
        subprocessImport.test(source),
        `${file} uses child processes or loopback SSH/PTY and must be listed in SUBPROCESS_TESTS`
      ).toBe(false)
    }
  })
})

describe('cold-start lazy module boundaries and i18n parity', () => {
  it('keeps heavy main-process runtime dependencies off top-level static imports', () => {
    for (const file of ['src/core/sodium.ts', 'src/main/secrets.ts', 'src/main/ssh/connect.ts', 'src/main/init-gates.ts', 'src/main/ssh/net.ts', 'src/main/sessions.ts']) {
      const staticValueImports = fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^import\s+(?!type\b).*from\s+['"](?:ssh2|socks|chokidar|libsodium-wrappers-sumo)['"]/.test(line.trim()))
      expect(staticValueImports, `unexpected eager import in ${file}`).toEqual([])
    }
  })

  it('initializes libsodium on demand and exposes the loaded instance synchronously afterwards', async () => {
    const sodium = await getSodium()
    expect(getLoadedSodium()).toBe(sodium)
  })

  it('evaluates Chinese and English translations identically across lazy dictionary tables', () => {
    expect(translate('zh', 'overview.title')).toBe('总览')
    expect(translate('en', 'overview.title')).toBe('Overview')
    expect(translate('zh', 'cleanup.ui.cleanSize', { size: '1.2 GB' })).toBe('清理 1.2 GB')
    expect(translate('en', 'cleanup.ui.cleanSize', { size: '1.2 GB' })).toBe('Clean 1.2 GB')
    expect(translate('zh', 'whatsNew.updated', { version: '0.4.0' })).toBe('HopLine 已更新到 0.4.0')
    expect(translate('en', 'whatsNew.updated', { version: '0.4.0' })).toBe('HopLine has updated to 0.4.0')
  })
})

describe('installer slimming and font subset rules', () => {
  it('excludes bundled frontend packages, cross-platform native prebuilds, and non-target Electron locales', () => {
    const builder = load(fs.readFileSync('electron-builder.yml', 'utf8')) as {
      files: string[]
      asarUnpack: string[]
      electronLanguages: string[]
      mac: { files: string[] }
      win: { files: string[]; asarUnpack: string[] }
      linux: { files: string[] }
    }
    expect(builder.electronLanguages).toEqual(['zh_CN', 'en'])
    expect(builder.asarUnpack).toEqual(expect.arrayContaining(['**/*.node', '**/spawn-helper']))
    for (const pattern of [
      '!node_modules/lucide-react{,/**}',
      '!node_modules/react-dom{,/**}',
      '!node_modules/@xterm{,/**}',
      '!node_modules/@fontsource{,/**}',
      '!node_modules/@radix-ui{,/**}',
      '!node_modules/chokidar{,/**}',
      '!node_modules/**/*.pdb',
      '!node_modules/cpu-features/{deps,src,test}{,/**}'
    ]) {
      expect(builder.files).toContain(pattern)
    }
    expect(builder.mac.files).toContain('!node_modules/node-pty/prebuilds/win32-*{,/**}')
    expect(builder.linux.files).toContain('!node_modules/node-pty/prebuilds/win32-*{,/**}')
    expect(builder.win.files).toContain('!node_modules/node-pty/prebuilds/darwin-*{,/**}')
  })

  it('embeds only latin 400 and 500 woff2 JetBrains Mono subsets in renderer CSS', () => {
    const css = fs.readFileSync('src/renderer/src/index.css', 'utf8')
    expect(css).toContain('jetbrains-mono-latin-400-normal.woff2')
    expect(css).toContain('jetbrains-mono-latin-500-normal.woff2')
    expect(css).not.toContain('@fontsource/jetbrains-mono/400.css')
    expect(css).not.toContain('format("woff")')
  })
})
