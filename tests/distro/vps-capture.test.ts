import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { expect, it } from 'vitest'
import { parseCollect } from '../../src/core/collect/parse'
import { COLLECT_SCRIPT } from '../../src/core/collect/script'
import { parseSecurity } from '../../src/core/security/parse'
import { SECURITY_SCRIPT } from '../../src/core/security/script'

const alias = 'hopline-test'
const fixtures = path.join(import.meta.dirname, 'fixtures', 'ubuntu-24-vps')

function capture(command: string, script: string) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    `root@${alias}`, command
  ], { input: script, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}

function redact(output: string) {
  // Keep the process row and executable column. Command arguments can contain
  // secrets or the probe itself and are not suitable for a public fixture.
  return output.replace(/(===HOPLINE:processes===\n)([\s\S]*?)(\n#HOPLINE-END)/, (_all, begin, rows, end) =>
    begin + rows.replace(/^(\s*\d+\s+\S+\s+[\d.]+\s+\S+)\s+.*$/gm, '$1 [arguments redacted]') + end)
    .replace(/(===HOPLINE:uname===\nLinux )\S+/, `$1${alias}`)
    .replace(/(===HOPLINE:ps===\n)([\s\S]+)$/, (_all, begin, rows) =>
      begin + rows.replace(/^(\s*\d+\s+\S+\s+\S+)\s+.*$/gm, '$1 [arguments redacted]'))
    .replace(/\[(?:[a-f\d:.]+)(?:%[\w.-]+)?\]|(?<![\w.])(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*|\b(?:\d{1,3}\.){3}\d{1,3}\b/gi, (token) => {
      const address = token.replace(/^\[|\]$/g, '').split('%')[0]!
      return isIP(address) ? alias : token
    })
    .replace(/[ \t]+$/gm, '')
}

it.skipIf(process.env.HOPLINE_VPS_CAPTURE !== '1')('captures read-only Ubuntu VPS fixtures through the explicit SSH alias', () => {
  const basic = capture('runuser -u nobody -- sh -s',
    readFileSync(path.join(import.meta.dirname, 'probes', 'basic.sh'), 'utf8'))
  const collect = capture('runuser -u nobody -- sh -s', COLLECT_SCRIPT)
  const security = capture('sh -s', SECURITY_SCRIPT)
  expect(basic).toContain('===HOPLINE:os-release===')
  const status = parseCollect(collect, Date.now()), report = parseSecurity(security, Date.now())
  expect(status.os).toMatchObject({ status: 'complete' })
  expect(status.listeners).toMatchObject({ status: 'partial' })
  expect(report.sshd).toMatchObject({ status: 'complete' })
  mkdirSync(fixtures, { recursive: true })
  for (const [name, stdout] of [['basic', basic], ['collect', collect], ['security', security]] as const) {
    const destination = path.join(fixtures, `${name}.txt`)
    const temporary = `${destination}.${process.pid}.tmp`
    writeFileSync(temporary, redact(stdout), { flag: 'wx' })
    renameSync(temporary, destination)
  }
}, 280_000)

it('replays the Ubuntu VPS status and SSH configuration fixtures', () => {
  const now = Date.UTC(2026, 10, 24)
  const status = parseCollect(readFileSync(path.join(fixtures, 'collect.txt'), 'utf8'), now)
  const security = parseSecurity(readFileSync(path.join(fixtures, 'security.txt'), 'utf8'), now)
  expect(status.os).toMatchObject({ status: 'complete', data: { name: 'Ubuntu 24.04 LTS', architecture: 'x86_64' } })
  expect(status.listeners).toMatchObject({ status: 'partial', data: expect.arrayContaining([expect.objectContaining({ port: 22, process: null })]) })
  expect(status.docker).toMatchObject({ status: 'unavailable', reason: 'not-installed' })
  expect(security.sshd).toMatchObject({ status: 'complete', data: expect.objectContaining({ port: '22' }) })
})
