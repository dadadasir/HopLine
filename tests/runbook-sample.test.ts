import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { RunbookEngine, envCommand } from '../src/core/runbook/engine'
import { timezoneRunbook } from '../src/core/runbook/samples'
import type { StepResult } from '../src/core/runbook/types'

it.each([false, true])('executes the sample with timedatectl=%s in a temporary filesystem', async (timedatectl) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-tz-sample-'))
  const bin = path.join(root, 'bin'), zoneinfo = path.join(root, 'usr/share/zoneinfo')
  fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'etc')); fs.mkdirSync(path.join(root, 'tmp')); fs.mkdirSync(path.join(zoneinfo, 'Asia'), { recursive: true })
  fs.writeFileSync(path.join(zoneinfo, 'UTC'), 'UTC'); fs.writeFileSync(path.join(zoneinfo, 'Asia/Shanghai'), 'Shanghai')
  fs.writeFileSync(path.join(root, 'etc/timezone'), 'UTC\n'); fs.symlinkSync(path.join(zoneinfo, 'UTC'), path.join(root, 'etc/localtime'))
  for (const utility of ['sh', 'ln', 'readlink', 'cat']) fs.symlinkSync(execFileSync('/bin/sh', ['-c', `command -v ${utility}`], { encoding: 'utf8' }).trim(), path.join(bin, utility))
  // Simulate root ownership while keeping every write inside the temporary directory.
  fs.writeFileSync(path.join(bin, 'stat'), "#!/bin/sh\nprintf '0:1'", { mode: 0o700 })
  if (timedatectl) fs.writeFileSync(path.join(bin, 'timedatectl'), `#!/bin/sh
if [ "$1" = show ]; then cat "$FIXTURE/etc/timezone"
else printf '%s\\n' "$2" > "$FIXTURE/etc/timezone" && ln -snf "$FIXTURE/usr/share/zoneinfo/$2" "$FIXTURE/etc/localtime"; fi
`, { mode: 0o700 })
  const book = structuredClone(timezoneRunbook), results: StepResult[] = []
  for (const key of ['check', 'apply', 'verify', 'rollback'] as const) {
    book.steps[0][key] = book.steps[0][key]!.replaceAll('/etc/', `${root}/etc/`).replaceAll('/tmp/hopline-tz-prev', `${root}/tmp/hopline-tz-prev`).replaceAll('/usr/share/zoneinfo/', `${root}/usr/share/zoneinfo/`)
  }
  const engine = new RunbookEngine(async (script, { env, stdin }) => {
    if (script === 'id -u') return { code: 0, stdout: '0', stderr: '' }
    return new Promise((resolve) => {
      const child = execFile('/bin/sh', ['-c', envCommand(script, env)], { env: { PATH: bin, FIXTURE: root } }, (error, stdout, stderr) => {
        resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr })
      })
      child.stdin!.end(stdin ?? '')
    })
  }, (result) => results.push(result))
  try {
    const params = { TZ: 'Asia/Shanghai' }
    expect((await engine.plan(book, params)).steps[0].status).toBe('needed')
    expect(await engine.run(book, params, ['timezone'])).toMatchObject({ executed: 1 })
    expect(fs.readFileSync(path.join(root, 'etc/timezone'), 'utf8')).toBe('Asia/Shanghai\n')
    expect(fs.readFileSync(path.join(root, 'tmp/hopline-tz-prev'), 'utf8')).toBe('UTC\n')
    expect((await engine.plan(book, params)).steps[0].status).toBe('already')
    await engine.run(book, params, ['timezone'])
    expect((await engine.plan(book, { TZ: 'Missing/Zone' })).steps[0].status).toBe('unknown')
    const failing = structuredClone(book); failing.steps[0].verify = 'exit 1'
    await engine.plan(failing, { TZ: 'UTC' })
    expect(await engine.run(failing, { TZ: 'UTC' }, ['timezone'])).toMatchObject({ failed: 1 })
    expect(results.at(-1)?.rollback).toBe(true)
    expect(fs.readFileSync(path.join(root, 'etc/timezone'), 'utf8')).toBe('Asia/Shanghai\n')
    fs.rmSync(path.join(root, 'tmp/hopline-tz-prev'))
    const victim = path.join(root, 'victim'); fs.writeFileSync(victim, 'do not touch')
    fs.symlinkSync(victim, path.join(root, 'tmp/hopline-tz-prev'))
    await engine.plan(book, { TZ: 'UTC' })
    expect(await engine.run(book, { TZ: 'UTC' }, ['timezone'])).toMatchObject({ failed: 1 })
    expect(results.at(-1)?.reason).toContain('未自动回滚')
    expect(fs.readFileSync(victim, 'utf8')).toBe('do not touch')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
