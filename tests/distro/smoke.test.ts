import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { describeDistros, DISTRO_DIR } from './harness'
import { execSsh } from './ssh'

describeDistros('all', (target) => {
  for (const user of ['root', 'admin', 'ops'] as const) {
    it(`${user} 可以使用公钥登录`, async () => {
      const result = await execSsh(target(), target().users[user], 'id -un')
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(user)
    })
    it(`${user} 可以使用密码登录`, async () => {
      const result = await execSsh(target(), target().users[user], 'id -un', '', target().adminPassword)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(user)
    })
  }

  it('admin 必须提供 sudo 密码', async () => {
    expect((await execSsh(target(), target().users.admin, 'sudo -k -n true')).code).not.toBe(0)
    const wrong = await execSsh(target(), target().users.admin, "sudo -k -S -p '' true", '错误密码\n')
    expect(wrong.code).not.toBe(0)
    const result = await execSsh(target(), target().users.admin, "sudo -k -S -p '' true", `${target().adminPassword}\n`)
    expect(result.code, result.stderr).toBe(0)
  })

  it('ops 可以免密码使用 sudo', async () => {
    const result = await execSsh(target(), target().users.ops, 'sudo -n true')
    expect(result.code, result.stderr).toBe(0)
  })

  it('基础探测包含全部分隔标记', async () => {
    const script = await readFile(path.join(DISTRO_DIR, 'probes/basic.sh'), 'utf8')
    const result = await execSsh(target(), target().users.ops, 'sh -s', script)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.match(/^===HOPLINE:[a-z-]+===$/gm)).toEqual([
      '===HOPLINE:os-release===', '===HOPLINE:uname===', '===HOPLINE:id===', '===HOPLINE:df===',
      '===HOPLINE:memory===', '===HOPLINE:loadavg===', '===HOPLINE:listeners===', '===HOPLINE:ps==='
    ])
    // ps 段按列名解析（不按固定宽度切），必须包含 PID 1。
    const psLines = result.stdout.split('===HOPLINE:ps===\n')[1]!.split('\n').filter((line) => line.trim() !== '')
    const header = psLines[0]!.trim().split(/\s+/)
    const pidColumn = header.indexOf('PID')
    expect(pidColumn, psLines[0]).toBeGreaterThanOrEqual(0)
    const pids = psLines.slice(1).map((line) => line.trim().split(/\s+/)[pidColumn])
    expect(pids, psLines.join('\n')).toContain('1')
  })

  it('保留发行版的 shell 和初始化系统差异', async () => {
    if (target().name === 'alpine-3') {
      const result = await execSsh(target(), target().users.ops, 'test ! -x /bin/bash && test ! -x /usr/bin/bash && readlink /bin/sh')
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('busybox')
    } else if (target().name === 'ubuntu-24-systemd') {
      const result = await execSsh(target(), target().users.root, 'systemctl is-system-running --wait')
      expect(['running', 'degraded']).toContain(result.stdout.trim())
      expect([0, 1]).toContain(result.code)
      expect((await execSsh(target(), target().users.root, 'cat /proc/1/comm')).stdout.trim()).toBe('systemd')
    }
  })
})
