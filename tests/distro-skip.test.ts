import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DISTROS, distroSkipReason, startDistro } from './distro/harness'

const dockerInfo = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), execFileSync: dockerInfo
}))

beforeEach(() => {
  vi.stubEnv('HOPLINE_DISTRO', '1')
  vi.stubEnv('HOPLINE_DISTRO_SKIP', '')
  dockerInfo.mockReset().mockReturnValue('29')
})
afterEach(() => vi.unstubAllEnvs())

it('仅跳过指定的 systemd 靶机，其余五个保持启用', async () => {
  vi.stubEnv('HOPLINE_DISTRO_SKIP', ' ubuntu-24-systemd ')
  expect(distroSkipReason('ubuntu-24-systemd')).toContain('HOPLINE_DISTRO_SKIP')
  await expect(startDistro('ubuntu-24-systemd')).rejects.toThrow('HOPLINE_DISTRO_SKIP')
  expect(dockerInfo).not.toHaveBeenCalled()
  for (const name of DISTROS.filter((name) => name !== 'ubuntu-24-systemd')) {
    expect(distroSkipReason(name)).toBeUndefined()
  }
})

it('支持逗号分隔，并拒绝拼错的发行版名称', () => {
  vi.stubEnv('HOPLINE_DISTRO_SKIP', 'alpine-3, ubuntu-24-systemd')
  expect(distroSkipReason('alpine-3')).toContain('跳过')
  expect(distroSkipReason('ubuntu-24')).toBeUndefined()
  vi.stubEnv('HOPLINE_DISTRO_SKIP', 'ubuntu-systemd')
  expect(() => distroSkipReason()).toThrow('未知发行版')
})
