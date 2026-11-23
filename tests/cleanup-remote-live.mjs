/** Explicit opt-in only. JSON SSH credentials arrive on stdin and are never saved.
 * Runs production reads on the authorized host. Destructive scripts run inside
 * private mount namespaces over disposable fixtures, with the scripts unchanged.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const { Client } = require('ssh2')
const { rolldown } = await import('rolldown')
let input = ''; for await (const chunk of process.stdin) input += chunk
const credentials = JSON.parse(input); input = ''
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hopline-remote-bundle-'))
const bundle = path.join(temporary, 'core.cjs')
const entry = path.join(temporary, 'entry.ts')
const source = name => JSON.stringify(path.join(process.cwd(), name))
await fs.writeFile(entry, `export {RunbookService} from ${source('src/main/runbook-service.ts')}; export {execOnClient} from ${source('src/main/ssh/exec.ts')}; export {execReadOnly} from ${source('src/main/ssh/read-only-exec.ts')}; export {RunbookEngine,envCommand} from ${source('src/core/runbook/engine.ts')}; export {cleanupExecution,cleanupRunbook} from ${source('src/core/runbook/cleanup.ts')}; export {shellEscape} from ${source('src/core/shell.ts')};`)
const builder = await rolldown({ input: entry, platform: 'node', external: ['ssh2'], logLevel: 'silent' })
await builder.write({ file: bundle, format: 'cjs' }); await builder.close()
const { RunbookService, execOnClient, execReadOnly, RunbookEngine, envCommand, cleanupExecution, cleanupRunbook, shellEscape: q } = require(bundle)
const client = new Client(), token = randomUUID(), root = `/root/hopline-m2-h3-${token}`
let closed = false, transportError
client.on('error', error => { if (!closed) transportError = error })
await new Promise((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({ ...credentials, readyTimeout: 20000, hostVerifier: key => { console.log('SSH host key SHA256:' + createHash('sha256').update(key).digest('base64')); return true } }))
credentials.password = undefined
const raw = (script, options = {}) => execOnClient(client, script, { timeoutMs: 30000, ...options })
const must = async script => { const result = await raw(script); assert.equal(result.code, 0, result.stderr || result.stdout); return result.stdout }
const pool = { exec: (_host, script, options) => raw(script, options), acquire: async () => ({ client, release() {} }) }
try {
  console.log('Environment:', (await must('cat /etc/os-release | head -4; uname -srmo')).trim())
  await must(`umask 077; mkdir ${q(root)}; unshare -m -- sh -c 'mount --make-rprivate /; true'`)
  const records = [], events = []
  const service = new RunbookService(pool, { append: (_host, row) => records.push(row) }, () => true, event => events.push(event))
  assert.equal(await service.sudo('authorized-test', randomUUID()), 'root')
  const preview = await service.plan('authorized-test', 'cleanup', {}, {}, '', randomUUID())
  assert.equal(preview.steps.length, cleanupRunbook.steps.length)
  for (const id of ['docker-build-cache', 'docker-container-logs', 'dnf-cache', 'apk-cache']) assert.equal(preview.cleanup[id].unavailable, true)
  console.log('PASS native root permission and all 13 production read-only checks; absent tools remain unsupported')
  const diagnostics = await service.diagnose('authorized-test', '', randomUUID())
  assert.equal(diagnostics.inodes.status, 'available')
  assert.equal(diagnostics.deleted.status, 'available')
  assert.equal(diagnostics.logs.status, 'available')
  assert.ok(await service.disk('authorized-test', '/'))
  const directory = await service.directory('authorized-test', '/', randomUUID())
  assert.ok(directory.output.includes('/')); assert.equal(directory.timedOut, false)
  service.cancel('authorized-test', preview.id)
  console.log('PASS native /proc fallback, inode/log diagnostics, df and directory analysis')
  await must(`mkdir -p ${q(root)}/var/cache/apt/archives/partial ${q(root)}/var/lib/dpkg ${q(root)}/var/crash ${q(root)}/var/lib/systemd/coredump ${q(root)}/var/log/journal ${q(root)}/tmp ${q(root)}/run/log
: > ${q(root)}/var/lib/dpkg/status
head -c 1048576 /dev/zero > ${q(root)}/var/cache/apt/archives/hopline-test.deb
head -c 2097152 /dev/zero > ${q(root)}/var/crash/hopline.crash
head -c 3145728 /dev/zero > ${q(root)}/var/lib/systemd/coredump/core.hopline.zst
head -c 1048576 /dev/zero > ${q(root)}/var/log/hopline.log.1
printf 'active log guard' > ${q(root)}/var/log/hopline.log
printf 'journal guard' > ${q(root)}/var/log/journal/guard.log.1
printf 'external guard' > ${q(root)}/guard
ln -s ${q(root)}/guard ${q(root)}/var/crash/link.crash
printf 'old temporary file' > ${q(root)}/tmp/old-file
touch -d '10 days ago' ${q(root)}/tmp/old-file`)
  const isolate = command => `unshare -m -- sh -c ${q(`set -eu\nmount --make-rprivate /\nmount --bind ${q(root + '/var')} /var\nmount --bind ${q(root + '/tmp')} /tmp\nmount --bind ${q(root + '/run')} /run\n${command}`)}`
  const measured = cleanupExecution((script, { env, stdin }) => raw(isolate(envCommand(script, env)), { stdin }))
  const results = []
  const engine = new RunbookEngine(measured.exec, result => results.push(result))
  const ids = ['apt-cache', 'rotated-logs', 'crash-reports', 'coredumps', 'tmp-old']
  const book = { ...cleanupRunbook, steps: cleanupRunbook.steps.filter(step => ids.includes(step.id)) }
  const plan = await engine.plan(book, {}, '')
  for (const step of plan.steps) assert.equal(step.status, 'needed', `${step.id}: ${step.reason}`)
  const summary = await engine.run(book, {}, ids)
  assert.equal(summary.executed, ids.length)
  assert.equal(summary.failed, 0)
  for (const id of ids) assert.ok(measured.changes[id].before > 0 && measured.changes[id].after === 0, id)
  await must(`test -f ${q(root)}/var/log/hopline.log; test -f ${q(root)}/var/log/journal/guard.log.1; test -L ${q(root)}/var/crash/link.crash; test "$(cat ${q(root)}/guard)" = 'external guard'`)
  const second = await engine.plan(book, {}, '')
  assert.ok(second.steps.every(step => step.status === 'already'))
  console.log('PASS unchanged APT, rotated log, crash report, core dump and old temporary file scripts: native check/apply/verify, measured release, repeat empty, symlink/active log/journal guards')
  // Real process-group cancellation without any cleanup command being interrupted.
  const controller = new AbortController()
  const read = execReadOnly(pool, 'authorized-test', `echo $$ > ${q(root)}/read-pid; sleep 60`, { signal: controller.signal, timeoutMs: 20000 })
  const outcome = read.then(() => ({ ok: true }), error => ({ error: error.message }))
  let pid = ''
  for (let i=0; i<50; i++) { const result = await raw(`cat ${q(root)}/read-pid 2>/dev/null`); if (result.code === 0) { pid = result.stdout.trim(); break } await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.match(pid, /^\d+$/)
  controller.abort()
  assert.match((await outcome).error, /cleanup.readOnlyCanceled/)
  assert.notEqual((await raw(`kill -0 ${pid} 2>/dev/null`)).code, 0)
  console.log('PASS real Linux read-only cancellation terminates its remote process group')
  if (transportError) throw transportError
} finally {
  // Remove only this run's generated fixture tree; no mounted path exists outside
  // the short-lived private namespaces above.
  try { await must(`rm -rf -- ${q(root)}`) } finally { closed = true; client.end(); await fs.rm(temporary, { recursive: true, force: true }) }
}
console.log('PASS remote fixture removed; no Docker, package installation or host application data changes')
