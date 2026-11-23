import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 这些测试只模拟 Docker/SSH，不监听端口；用 HOPLINE_DISTRO_UNIT=1 单独运行。
const mocks = vi.hoisted(() => ({
  exec: vi.fn(), sync: vi.fn(), ssh: vi.fn(), rm: vi.fn(), rmSync: vi.fn(),
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), mkdtemp: vi.fn()
}))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }), execFileSync: mocks.sync }
})
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
  mkdtemp: mocks.mkdtemp, rm: mocks.rm
}))
vi.mock('node:fs', () => ({ rmSync: mocks.rmSync }))
vi.mock('./ssh', () => ({ execSsh: mocks.ssh }))

describe.skipIf(process.env.HOPLINE_DISTRO_UNIT !== '1')('靶机生命周期（不需要 Docker）', () => {
  let exitHook: (() => void) | undefined
  let imageExists: boolean
  let failCommand: string | undefined

  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.stubEnv('HOPLINE_DISTRO', '1')
    exitHook = undefined
    imageExists = true
    failCommand = undefined
    const originalOnce = process.once.bind(process)
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      if (event === 'exit') { exitHook = listener as () => void; return process }
      if (event === 'SIGINT' || event === 'SIGTERM') return process
      return originalOnce(event, listener)
    })
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.sync.mockReturnValue('29.3.1')
    mocks.mkdtemp.mockResolvedValue('/tmp/hopline-distro-unit')
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith('.pub') ? 'ssh-ed25519 测试公钥' : '镜像构建内容')
    mocks.ssh.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    mocks.exec.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'ssh-keygen') {
        if (failCommand === 'ssh-keygen') throw new Error('模拟密钥生成失败')
        return { stdout: '', stderr: '' }
      }
      if (args[0] === failCommand) throw new Error(`模拟 ${failCommand} 失败`)
      if (args[0] === 'image') {
        if (!imageExists) throw new Error('No such image')
        return { stdout: JSON.stringify([{ Size: 123456, Architecture: 'arm64' }]), stderr: '' }
      }
      if (args[0] === 'build') imageExists = true
      if (args[0] === 'inspect') {
        return { stdout: JSON.stringify([{ NetworkSettings: { Ports: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '43210' }] } } }]), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const commands = (verb: string): string[][] => mocks.exec.mock.calls
    .filter(([command, args]) => command === 'docker' && args[0] === verb)
    .map(([, args]) => args as string[])

  it('关闭开关时不调用 Docker', async () => {
    vi.stubEnv('HOPLINE_DISTRO', '0')
    const { distroSkipReason } = await import('./harness')
    expect(distroSkipReason()).toContain('未设置')
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('Docker 缺失或无法连接时给出跳过原因', async () => {
    mocks.sync.mockImplementation(() => { throw new Error('ENOENT') })
    const { distroSkipReason } = await import('./harness')
    expect(distroSkipReason()).toContain('Docker 不可用')
  })

  it('拒绝未知靶机，避免将任意名称用作构建路径', async () => {
    const { startDistro } = await import('./harness')
    await expect(startDistro('../ubuntu-24')).rejects.toThrow('未知发行版')
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('SSH 验证后返回随机映射端口，停止时删除容器及密钥且可重复调用', async () => {
    const { startDistro } = await import('./harness')
    const target = await startDistro('alpine-3')
    expect(target.port).toBe(43210)
    expect(target.host).toBe('127.0.0.1')
    expect(mocks.ssh).toHaveBeenCalledWith(expect.objectContaining({ port: 43210 }), 'root', 'true', '', undefined, 5000)
    expect(commands('create')[0]).toEqual(expect.arrayContaining(['127.0.0.1::22', 'hopline-distro=true', 'HOPLINE_PUBLIC_KEY=ssh-ed25519 测试公钥']))
    await target.stop()
    await target.stop()
    expect(commands('rm')).toHaveLength(1)
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/hopline-distro-unit', { recursive: true, force: true })
  })

  it('相同内容复用镜像，修改共享配置后使用新哈希构建', async () => {
    const { startDistro } = await import('./harness')
    const first = await startDistro('ubuntu-24')
    await first.stop()
    const second = await startDistro('ubuntu-24')
    await second.stop()
    expect(commands('build')).toHaveLength(0)
    const oldTag = commands('create')[0].at(-1)
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith('sshd_config') ? '修改后的配置' : '镜像构建内容')
    imageExists = false
    const third = await startDistro('ubuntu-24')
    await third.stop()
    expect(commands('build')).toHaveLength(1)
    expect(commands('create')[2].at(-1)).not.toBe(oldTag)
  })

  it('systemd 靶机传入 Docker Desktop 的 cgroup 与临时目录参数', async () => {
    const { startDistro } = await import('./harness')
    const target = await startDistro('ubuntu-24-systemd')
    expect(commands('create')[0]).toEqual(expect.arrayContaining([
      '--privileged', '--cgroupns=host', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '/run/lock'
    ]))
    await target.stop()
  })

  it.each(['create', 'start'])('%s 失败时仍尝试删除可能已创建的容器和密钥', async (command) => {
    failCommand = command
    const { startDistro } = await import('./harness')
    await expect(startDistro('debian-12')).rejects.toThrow(`模拟 ${command} 失败`)
    expect(commands('rm')).toHaveLength(1)
    expect(mocks.rm).toHaveBeenCalled()
  })

  it('生成密钥失败时删除临时目录，不创建容器', async () => {
    failCommand = 'ssh-keygen'
    const { startDistro } = await import('./harness')
    await expect(startDistro('rocky-9')).rejects.toThrow('模拟密钥生成失败')
    expect(commands('create')).toHaveLength(0)
    expect(mocks.rm).toHaveBeenCalled()
  })

  it('SSH 认证失败且容器已退出时不返回靶机，并清理资源', async () => {
    mocks.ssh.mockRejectedValue(new Error('模拟 SSH 认证失败'))
    const { startDistro } = await import('./harness')
    await expect(startDistro('alpine-3')).rejects.toThrow('sshd 未就绪')
    expect(commands('rm')).toHaveLength(1)
    expect(mocks.rm).toHaveBeenCalled()
  })

  it('私钥删除失败时保留退出清理兜底', async () => {
    const { startDistro } = await import('./harness')
    const target = await startDistro('debian-12')
    mocks.rm.mockRejectedValueOnce(new Error('模拟目录删除失败'))
    await expect(target.stop()).rejects.toThrow('模拟目录删除失败')
    exitHook!()
    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/hopline-distro-unit', { recursive: true, force: true })
  })

  it('清理失败保留退出兜底，退出时再次删除容器和私钥', async () => {
    const { startDistro } = await import('./harness')
    const target = await startDistro('ubuntu-22')
    failCommand = 'rm'
    await expect(target.stop()).rejects.toThrow('模拟 rm 失败')
    expect(mocks.rm).toHaveBeenCalled()
    expect(exitHook).toBeDefined()
    exitHook!()
    expect(mocks.sync).toHaveBeenCalledWith('docker', ['rm', '-f', expect.stringContaining('hopline-distro-ubuntu-22-')], expect.anything())
    expect(mocks.rmSync).toHaveBeenCalledWith('/tmp/hopline-distro-unit', { recursive: true, force: true })
  })
})
