import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installShellIntegration as install, uninstallShellIntegration as uninstall } from '../src/core/runbook/shell-integration'
import { RunbookEngine } from '../src/core/runbook/engine'
import { RunbookService } from '../src/main/runbook-service'
import { ShellIntegrationStore } from '../src/main/shell-integration-store'
import { OpLog } from '../src/main/oplog'

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-shell-runbook-')) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
const exec = (script: string, shell = '/bin/bash') => {
  const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home, SHELL: shell } })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}
const rc = () => path.join(home, '.bashrc')
const backup = () => `${rc()}.hopline-backup`
const step = install.steps[0], remove = uninstall.steps[0]
it('all runbook commands parse as POSIX sh; no sudo or additional dependency', () => {
  for (const book of [install, uninstall]) for (const item of book.steps) {
    expect(item.sudo).toBe(false)
    for (const script of [item.check, item.apply, item.verify, item.rollback].filter(Boolean)) {
      expect(spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' })
    }
  }
})
it.each(['', '# user config', '# user config\n', '# user config\n\n', 'export NOTE="中文"\n'])('round-trips original bytes %j and repeated install is unchanged', (original) => {
  fs.writeFileSync(rc(), original, { mode: 0o640 })
  expect(exec(step.check).code).toBe(10)
  expect(exec(step.apply)).toMatchObject({ code: 0, stderr: '' })
  const installed = fs.readFileSync(rc())
  expect(exec(step.check).code).toBe(0)
  expect(exec(step.verify).code).toBe(0)
  expect(fs.statSync(rc()).mode & 0o777).toBe(0o640)
  expect(exec(step.apply).code).toBe(0)
  expect(fs.readFileSync(rc())).toEqual(installed)
  expect(fs.readFileSync(backup(), 'utf8')).toBe(original)
  expect(exec(remove.apply).code).toBe(0)
  expect(exec(remove.verify).code).toBe(0)
  expect(fs.readFileSync(rc(), 'utf8')).toBe(original)
  expect(fs.existsSync(backup())).toBe(false)
})
it('keeps edits on both sides, preserves the first backup across upgrades and reports retention', () => {
  fs.writeFileSync(rc(), '# original\n')
  expect(exec(step.apply).code).toBe(0)
  fs.writeFileSync(rc(), '# before\n' + fs.readFileSync(rc(), 'utf8').replace('__hopline_loaded=1', '__hopline_loaded=old') + '# after without newline')
  expect(exec(step.check).code).toBe(10)
  expect(exec(step.apply).code).toBe(0)
  expect(exec(step.verify).code).toBe(0)
  expect(exec(remove.apply)).toMatchObject({ code: 0, stdout: 'shellIntegration.backupKept\n' })
  expect(fs.readFileSync(rc(), 'utf8')).toBe('# before\n# original\n# after without newline')
  expect(fs.readFileSync(backup(), 'utf8')).toBe('# original\n')
})
it('rolls back from the first backup and leaves invalid original files untouched on apply failure', () => {
  fs.writeFileSync(rc(), '# original\n'); exec(step.apply)
  expect(exec(step.rollback!).code).toBe(0)
  expect(fs.readFileSync(rc(), 'utf8')).toBe('# original\n')
  fs.writeFileSync(rc(), 'if !\n')
  expect(exec(step.apply).code).not.toBe(0)
  expect(fs.readFileSync(rc(), 'utf8')).toBe('if !\n')
  expect(fs.readdirSync(home).filter((name) => name !== '.bashrc.hopline-backup').some((name) => /hopline-[A-Za-z0-9]{6}$/.test(name))).toBe(false)
})
it('refuses unsupported shells, symlinks and malformed blocks without editing anything', () => {
  expect(exec(step.check, '/bin/fish').code).not.toBe(0)
  const target = path.join(home, 'other'); fs.writeFileSync(target, 'keep')
  fs.symlinkSync(target, rc()); expect(exec(step.apply).code).not.toBe(0)
  expect(fs.readFileSync(target, 'utf8')).toBe('keep'); fs.unlinkSync(rc())
  fs.writeFileSync(rc(), '\n# >>> hopline shell integration >>>\nunfinished')
  expect(exec(step.check).code).not.toBe(10)
  expect(exec(remove.apply).code).not.toBe(0)
})
it.skipIf(spawnSync('zsh', ['--version']).status !== 0)('selects zshrc and verifies with zsh', () => {
  const file = path.join(home, '.zshrc'); fs.writeFileSync(file, '# zsh config')
  expect(exec(step.apply, '/bin/zsh')).toMatchObject({ code: 0, stderr: '' })
  expect(exec(step.verify, '/bin/zsh').code).toBe(0)
  expect(fs.existsSync(rc())).toBe(false)
  expect(exec(remove.apply, '/bin/zsh').code).toBe(0)
  expect(fs.readFileSync(file, 'utf8')).toBe('# zsh config')
})
it('engine installs only selected steps and handles verification failure with rollback', async () => {
  fs.writeFileSync(rc(), '# original\n')
  const execute = vi.fn(async (script: string) => exec(script)), engine = new RunbookEngine(execute)
  await engine.plan(install, {}); expect(await engine.run(install, {}, [])).toMatchObject({ skipped: 1 })
  expect(fs.existsSync(backup())).toBe(false)
  await engine.plan(install, {})
  execute.mockImplementation(async (script) => script === step.verify ? { code: 1, stdout: '', stderr: '' } : exec(script))
  expect(await engine.run(install, {}, [step.id])).toMatchObject({ failed: 1 })
  expect(fs.readFileSync(rc(), 'utf8')).toBe('# original\n')
})
it('service records only verified install/uninstall success; store persists, deletes and prunes hosts', async () => {
  const store = new ShellIntegrationStore(home)
  const execute = vi.fn(async (_id: string, script: string) => ({ ...exec(script), timedOut: false, truncated: false, signal: null }))
  const service = new RunbookService({ exec: execute }, new OpLog(path.join(home, 'log')), () => true, () => {})
  service.shellIntegrationChanged = (id, installed) => store.set(id, installed)
  const run = async (book: typeof install, selected = [book.steps[0].id]) => {
    const plan = await service.plan('host', book.id, {}); return service.run('host', plan.id, selected)
  }
  await run(install, []); expect(store.has('host')).toBe(false)
  expect(await run(install)).toMatchObject({ executed: 1 })
  expect(new ShellIntegrationStore(home).has('host')).toBe(true)
  expect(await run(install)).toMatchObject({ already: 1 })
  expect(await run(uninstall)).toMatchObject({ executed: 1 }); expect(store.has('host')).toBe(false)
  fs.writeFileSync(rc(), 'if !\n'); expect(await run(install)).toMatchObject({ failed: 1 }); expect(store.has('host')).toBe(false)
  store.set('a', true); store.set('b', true); store.prune((id) => id === 'b')
  expect(store.has('a')).toBe(false); expect(store.has('b')).toBe(true)
  store.set('b', false); expect(new ShellIntegrationStore(home).has('b')).toBe(false)
})
it('a missing rc file can be installed and uninstalled without leaving a new empty configuration', () => {
  expect(exec(step.apply).code).toBe(0)
  expect(exec(step.check).code).toBe(0)
  expect(exec(step.apply).code).toBe(0)
  expect(exec(remove.apply).code).toBe(0)
  expect(fs.existsSync(rc())).toBe(false)
  expect(fs.existsSync(backup())).toBe(false)
})
it('upgrades a legacy block at the start of the file without removing text outside it', () => {
  fs.writeFileSync(rc(), '# >>> hopline shell integration >>>\n# previous version\n# <<< hopline shell integration <<<\n# keep\n')
  expect(exec(step.check).code).toBe(10)
  expect(exec(step.apply).code).toBe(0)
  expect(exec(step.verify).code).toBe(0)
  expect(exec(remove.apply).code).toBe(0)
  expect(fs.readFileSync(rc(), 'utf8')).toBe('# keep\n')
})
