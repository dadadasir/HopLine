import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { signingConfig } = require('../scripts/mac-signing.cjs')
const { load } = require('js-yaml')
const workflow = load(fs.readFileSync('.github/workflows/package.yml', 'utf8'))
const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
const alternatives = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']
const credentials = {
  CSC_LINK: '/temporary/fixture-certificate.p12', CSC_KEY_PASSWORD: 'fixture-certificate-password',
  APPLE_ID: 'fixture@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'fixture-apple-password', APPLE_TEAM_ID: 'ABC1234567'
}
const temporary: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('optional macOS signing configuration', () => {
  it.each([{}, Object.fromEntries(required.map(key => [key, ''])), Object.fromEntries(required.map(key => [key, '  ']))])('ad-hoc signs the entire app without credentials', (env) => {
    expect(signingConfig(env)).toEqual({ mac: { identity: '-', hardenedRuntime: false, gatekeeperAssess: false, notarize: false } })
  })

  it('requires Developer ID distribution signing and notarization for the supplied team without embedding secrets', () => {
    const config = signingConfig({ ...credentials, CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    expect(config).toEqual({ forceCodeSigning: true, mac: { identity: 'ABC1234567', type: 'distribution', hardenedRuntime: true, gatekeeperAssess: false, notarize: true } })
    for (const [key, value] of Object.entries(credentials)) if (key !== 'APPLE_TEAM_ID') expect(JSON.stringify(config)).not.toContain(value)
  })

  it.each(required)('rejects a missing %s before packaging without logging supplied values', (missing) => {
    const env = { ...credentials, [missing]: '' }
    expect(() => signingConfig(env)).toThrow(missing)
    try { signingConfig(env) } catch (error) {
      for (const value of Object.values(credentials)) expect(String(error)).not.toContain(value)
    }
  })

  it.each(alternatives)('rejects ambiguous unsupported notarization credentials: %s', (key) => {
    expect(() => signingConfig({ ...credentials, [key]: 'fixture-secret' })).toThrow('本项目使用 Apple ID 公证')
    expect(() => signingConfig({ [key]: 'fixture-secret' })).toThrow('本项目使用 Apple ID 公证')
  })

  it.each(['SHORT', 'abc1234567', 'ABC1234567\n'])('rejects a malformed team selector without showing its value', (team) => {
    expect(() => signingConfig({ ...credentials, APPLE_TEAM_ID: team })).toThrow('APPLE_TEAM_ID 须为 10 位')
  })

  it.each([false, true])('loads and validates the actual YAML through installed electron-builder (signed=%s)', async (signed) => {
    for (const key of [...required, ...alternatives]) vi.stubEnv(key, '')
    if (signed) for (const [key, value] of Object.entries(credentials)) vi.stubEnv(key, value)
    const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
    const config = await getConfig(process.cwd())
    await validateConfiguration(config, { isEnabled: false })
    expect(config).toMatchObject({ appId: 'app.hopline.desktop', productName: 'Hopline',
      mac: { target: [{ target: 'zip', arch: ['arm64'] }], category: 'public.app-category.developer-tools',
        identity: signed ? 'ABC1234567' : '-', hardenedRuntime: signed, notarize: signed, gatekeeperAssess: false },
      win: { icon: 'build/win/icon.ico', target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }] },
      linux: { target: ['AppImage', 'deb'], icon: 'build/linux/icons' }
    })
    expect(config.forceCodeSigning).toBe(signed ? true : undefined)
    for (const value of [credentials.CSC_LINK, credentials.CSC_KEY_PASSWORD, credentials.APPLE_APP_SPECIFIC_PASSWORD]) expect(JSON.stringify(config)).not.toContain(value)
  })
})

function releaseFixture(state = 'missing') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-draft-release-'))
  temporary.push(root)
  fs.mkdirSync(path.join(root, 'artifacts')); fs.mkdirSync(path.join(root, 'bin'))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.copyFileSync('docs/release-notes-0.4.0.md', path.join(root, 'docs/release-notes-0.4.0.md'))
  fs.writeFileSync(path.join(root, 'state'), state)
  // Only this executable can receive gh calls. No GitHub credentials or network.
  const gh = path.join(root, 'bin', 'gh')
  fs.writeFileSync(gh, `#!${process.execPath}\nconst fs=require('node:fs');const root=process.env.FIXTURE_ROOT;const args=process.argv.slice(2);fs.appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');const state=fs.readFileSync(root+'/state','utf8');if(args[0]!=='release')process.exit(90);if(args[1]==='view'){if(state==='missing')process.exit(1);if(state==='network')process.exit(2);process.stdout.write(state+'\\n')}else if(args[1]==='create'){if(!args.includes('--draft')||!args.includes('--verify-tag'))process.exit(91);if(state==='network')process.exit(2);fs.writeFileSync(root+'/state','true')}else if(args[1]==='upload'){if(state!=='true')process.exit(92);if(process.env.FIXTURE_UPLOAD_FAIL==='1')process.exit(3)}else process.exit(93)\n`, { mode: 0o700 })
  // Exercise the same checksum and verification commands on macOS versions
  // without sha256sum. shasum produces and verifies the same two-space format.
  if (process.platform === 'darwin') {
    fs.writeFileSync(path.join(root, 'bin', 'sha256sum'), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n', { mode: 0o700 })
  }
  const write = (name: string, contents: string) => fs.writeFileSync(path.join(root, 'artifacts', name), contents)
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync('/bin/bash', ['-c', workflow.jobs['draft-release'].steps.at(-1).run], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, GITHUB_WORKSPACE: root, FIXTURE_ROOT: root, GH_REPO: 'fixture/project', RELEASE_TAG: 'v0.4.0', ...extra }
  })
  return { root, write, calls, run }
}

describe('draft release workflow', () => {
  it('only grants release-write permission to the tag-only job after all packages finish; manual builds never publish', () => {
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const release = workflow.jobs['draft-release']
    expect(release.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
    expect(release.needs).toBe('package')
    expect(release.permissions).toEqual({ contents: 'write', actions: 'read' })
    expect(release.concurrency['cancel-in-progress']).toBe(false)
    expect(release.steps[0]).toEqual({ uses: 'actions/checkout@v7', with: { ref: '${{ github.ref }}' } })
    expect(release.steps.find((step: { uses?: string }) => step.uses === 'actions/download-artifact@v7').with).toEqual({ pattern: 'hopline-community-*', path: 'artifacts', 'merge-multiple': true })
    const build = workflow.jobs.package.steps.find((step: { name?: string }) => step.name === 'Build package (never publish)')
    expect(build.run).toContain('--publish never')
    for (const key of required) expect(build.env[key]).toMatch(/runner\.os == 'macOS' && secrets\./)
    expect(workflow.jobs.package.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
  })

  it('validates tag builds before dependency installation and accepts only the exact package version', () => {
    const steps = workflow.jobs.package.steps
    const check = steps.find((step: { name?: string }) => step.name === 'Validate release tag')
    expect(check.if).toBe("startsWith(github.ref, 'refs/tags/')")
    expect(check.env.RELEASE_TAG).toBe('${{ github.ref_name }}')
    expect(steps.indexOf(check)).toBeLessThan(steps.findIndex((step: { run?: string }) => step.run === 'npm ci'))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-tag-version-'))
    temporary.push(root)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }))
    for (const tag of ['v0.4.0', 'v0.3.0', 'v0.4.0-rc.1', '0.4.0', 'v0.4.0; exit 0']) {
      const result = spawnSync('/bin/bash', ['-c', check.run], {
        cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, RELEASE_TAG: tag }
      })
      expect(result.status, result.stderr).toBe(tag === 'v0.4.0' ? 0 : 1)
      if (tag !== 'v0.4.0') expect(result.stderr).toContain('标签与 package.json 版本不一致')
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.1' }))
    expect(spawnSync('/bin/bash', ['-c', check.run], {
      cwd: root, env: { PATH: process.env.PATH, RELEASE_TAG: 'v0.4.0' }
    }).status).toBe(1)
  })

  it('limits tag packages to macOS arm64 while retaining manually selected test targets', () => {
    const expression = workflow.jobs.package.strategy.matrix.include as string
    // Evaluate the Actions expression with the same short-circuit operators for all supported inputs.
    const evaluate = (event: string, x64: boolean) => new Function('fromJSON', 'github', 'inputs',
      `return ${expression.slice(3, -2)}`)(JSON.parse, { event_name: event }, { include_x64: x64 })
    for (const x64 of [false, true]) expect(evaluate('push', x64)).toEqual([{ os: 'macos-15', platform: 'mac', arch: 'arm64' }])
    expect(evaluate('workflow_dispatch', false).length).toBe(3)
    expect(evaluate('workflow_dispatch', true).length).toBe(4)
  })

  it('hashes every package, excludes other files and attaches only assets plus the checksum file to a draft', () => {
    const fixture = releaseFixture()
    const packages = { 'Hopline-mac arm64.zip': 'arm64', 'Hopline-mac-x64.zip': 'x64', 'Hopline-linux.AppImage': 'appimage', 'Hopline-linux.deb': 'deb' }
    for (const [name, value] of Object.entries(packages)) fixture.write(name, value)
    fixture.write('builder-effective-config.yaml', 'must not be published')
    fixture.write('private.p12', 'must not be published')
    const result = fixture.run()
    expect(result.status, result.stderr).toBe(0)
    const checksum = fs.readFileSync(path.join(fixture.root, 'artifacts/SHA256SUMS.txt'), 'utf8')
    for (const [name, value] of Object.entries(packages)) expect(checksum).toContain(`${createHash('sha256').update(value).digest('hex')}  ${name}\n`)
    expect(checksum.trim().split('\n')).toHaveLength(4)
    const calls = fixture.calls()
    expect(calls.map(call => call[1])).toEqual(['view', 'create', 'view', 'upload'])
    expect(calls[1]).toContain('--draft')
    expect(calls[1]).toContain('--notes-file')
    const notes = calls[1]![calls[1]!.indexOf('--notes-file') + 1]!
    expect(fs.readFileSync(notes, 'utf8')).toBe(fs.readFileSync('docs/release-notes-0.4.0.md', 'utf8'))
    expect(calls[3].slice(calls[3].indexOf('--') + 1).sort()).toEqual([...Object.keys(packages), 'SHA256SUMS.txt'].sort())
    expect(calls.flat()).not.toContain('private.p12')
  })

  it('replaces attachments on an existing draft without recreating or publishing it', () => {
    const fixture = releaseFixture('true'); fixture.write('package.zip', 'zip')
    expect(fixture.run().status).toBe(0)
    expect(fixture.calls().map(call => call[1])).toEqual(['view', 'view', 'upload'])
    expect(fixture.calls().at(-1)).toContain('--clobber')
  })

  it('refuses to modify an already public release', () => {
    const fixture = releaseFixture('false'); fixture.write('package.zip', 'zip')
    const result = fixture.run()
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('该版本已公开，拒绝修改')
    expect(fixture.calls().map(call => call[1])).toEqual(['view'])
  })

  it('fails for an empty artifact set or a symbolic-link package before any release request', () => {
    const fixture = releaseFixture()
    expect(fixture.run().status).not.toBe(0)
    expect(fixture.calls()).toEqual([])
    fs.writeFileSync(path.join(fixture.root, 'outside'), 'keep')
    fs.symlinkSync('../outside', path.join(fixture.root, 'artifacts/package.zip'))
    expect(fixture.run().status).not.toBe(0)
    expect(fixture.calls()).toEqual([])
  })

  it('refuses a draft without the checked-in release notes', () => {
    const fixture = releaseFixture(); fixture.write('package.zip', 'zip')
    fs.rmSync(path.join(fixture.root, 'docs/release-notes-0.4.0.md'))
    expect(fixture.run().status).not.toBe(0); expect(fixture.calls()).toEqual([])
  })

  it.each(['network', 'upload'])('propagates %s failures without publishing', (failure) => {
    const fixture = releaseFixture(failure === 'network' ? 'network' : 'true'); fixture.write('package.zip', 'zip')
    expect(fixture.run({ FIXTURE_UPLOAD_FAIL: failure === 'upload' ? '1' : '0' }).status).not.toBe(0)
    expect(fixture.calls().some(call => ['edit', 'delete'].includes(call[1]!))).toBe(false)
    expect(fixture.calls().filter(call => call[1] === 'create').every(call => call.includes('--draft'))).toBe(true)
  })
})
