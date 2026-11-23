import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { parseSecurity } from '../../src/core/security/parse'
import { evaluate, securityScore } from '../../src/core/security/rules'
import { DISTROS } from './harness'
const root = path.join(import.meta.dirname, 'fixtures'), now = Date.UTC(2026, 9, 27)
for (const distro of DISTROS) {
  const file = path.join(root, distro, 'security.txt')
  it(`security snapshot: ${distro}`, async () => {
    const snapshot = parseSecurity(fs.readFileSync(file, 'utf8'), now), results = evaluate(snapshot, {}, now)
    expect(results.find((r) => r.id === 'ssh-root-login')?.status).toBe('fail')
    expect(results.find((r) => r.id === 'ssh-password-auth')?.status).toBe('fail')
    if (distro === 'ubuntu-24-systemd') expect(results.find((r) => r.id === 'firewall-off')?.status).toBe('fail')
    await expect(JSON.stringify({ snapshot, results, score: securityScore(results) }, null, 2) + '\n').toMatchFileSnapshot(path.join(root, distro, 'security.snapshot.json'))
  })
}
