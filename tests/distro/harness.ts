import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe } from 'vitest'
import { execSsh } from './ssh'

export interface DistroTarget {
  name: string
  host: string
  port: number
  keyPath: string
  users: { root: string; admin: string; ops: string }
  adminPassword: string
}

export const DISTROS = ['ubuntu-22', 'ubuntu-24', 'debian-12', 'rocky-9', 'alpine-3', 'ubuntu-24-systemd'] as const
export const DISTRO_DIR = path.dirname(fileURLToPath(import.meta.url))
// 仅用于本机临时测试容器；三个账号都设置密码，以便测试初始化前的不安全状态。
const TEST_PASSWORD = 'Hopline-test-only-2026'
const exec = promisify(execFile)
const resources = new Map<string, string>()
const builds = new Map<string, Promise<ImageInfo>>()
let hooksInstalled = false

interface ImageInfo {
  tag: string
  bytes: number
  architecture: string
  buildMs: number
  cached: boolean
}

async function docker(args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout } = await exec('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    const detail = error as Error & { stderr?: string }
    throw new Error(`Docker 命令失败（${args.slice(0, 2).join(' ')}）：${detail.stderr || detail.message}`)
  }
}

export function distroSkipReason(name?: string): string | undefined {
  const skipped = (process.env.HOPLINE_DISTRO_SKIP ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  for (const value of skipped) {
    if (!DISTROS.some((distro) => distro === value)) throw new Error(`HOPLINE_DISTRO_SKIP 包含未知发行版：${value}`)
  }
  if (name && skipped.includes(name)) return `HOPLINE_DISTRO_SKIP 跳过发行版 ${name}`
  if (process.env.HOPLINE_DISTRO !== '1') return '未设置 HOPLINE_DISTRO=1，跳过发行版测试'
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000, stdio: 'pipe' })
  } catch {
    return 'Docker 不可用，跳过发行版测试'
  }
  return undefined
}

function installCleanupHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  // exit 回调必须同步；覆盖正常退出、未捕获异常及 SIGINT/SIGTERM。
  process.once('exit', () => {
    for (const [container, directory] of resources) {
      try { execFileSync('docker', ['rm', '-f', container], { timeout: 10_000, stdio: 'ignore' }) } catch {
        console.error(`未能删除容器 ${container}，可按 hopline-distro 标签手动清理`)
      }
      try { rmSync(directory, { recursive: true, force: true }) } catch {
        console.error(`未能删除临时密钥目录：${directory}`)
      }
    }
  })
  process.once('SIGINT', () => process.exit(130))
  process.once('SIGTERM', () => process.exit(143))
}

async function ensureImage(name: string): Promise<ImageInfo> {
  const context = path.join(DISTRO_DIR, 'images')
  // 共享启动脚本、配置也参与哈希，避免只改 COPY 源文件时误用旧镜像。
  const hash = createHash('sha256')
  for (const file of [`${name}/Dockerfile`, 'setup.sh', 'entrypoint.sh', 'sshd_config']) {
    hash.update(file).update('\0').update(await readFile(path.join(context, file))).update('\0')
  }
  const tag = `hopline-distro-${name}:${hash.digest('hex').slice(0, 20)}`
  const existing = builds.get(tag)
  if (existing) return { ...await existing, buildMs: 0, cached: true }
  const building = (async () => {
    let cached = true
    try { await docker(['image', 'inspect', tag]) } catch { cached = false }
    const started = performance.now()
    if (!cached) {
      console.info(`正在首次构建 ${name}，拉取基础镜像可能需要数分钟`)
      await docker(['build', '--label', 'hopline-distro=true', '-t', tag, '-f', path.join(context, name, 'Dockerfile'), context], 900_000)
    }
    const buildMs = cached ? 0 : Math.round(performance.now() - started)
    const [info] = JSON.parse(await docker(['image', 'inspect', tag])) as Array<{ Size: number; Architecture: string }>
    return { tag, bytes: info.Size, architecture: info.Architecture, buildMs, cached }
  })()
  builds.set(tag, building)
  try { return await building } catch (error) { builds.delete(tag); throw error }
}

export async function startDistro(name: string): Promise<DistroTarget & { stop(): Promise<void> }> {
  if (!DISTROS.some((distro) => distro === name)) throw new Error(`未知发行版：${name}`)
  const reason = distroSkipReason(name)
  if (reason) throw new Error(reason)
  installCleanupHooks()
  const image = await ensureImage(name)
  const directory = await mkdtemp(path.join(tmpdir(), 'hopline-distro-'))
  const container = `hopline-distro-${name}-${randomUUID()}`
  resources.set(container, directory)
  let stopped = false
  let created = false
  let creationAttempted = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    try {
      if (creationAttempted) {
        try { await docker(['rm', '-f', container]) } catch (error) {
          // create 超时也可能已在引擎中建好容器；只忽略明确的“不存在”。
          if (!/No such container/i.test(String(error))) throw error
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    resources.delete(container)
    stopped = true
  }
  const started = performance.now()
  try {
    const keyPath = path.join(directory, 'id_ed25519')
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { timeout: 10_000 })
    const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
    const systemdArgs = name === 'ubuntu-24-systemd'
      ? ['--privileged', '--cgroupns=host', '--volume', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '--tmpfs', '/run/lock']
      : []
    // 分开 create/start：中途失败也能用预先登记的唯一名称清理。
    creationAttempted = true
    await docker(['create', '--name', container, '--label', 'hopline-distro=true',
      '--publish', '127.0.0.1::22', ...systemdArgs,
      '--env', `HOPLINE_PUBLIC_KEY=${publicKey}`, '--env', `HOPLINE_TEST_PASSWORD=${TEST_PASSWORD}`, image.tag])
    created = true
    await docker(['start', container])
    const [state] = JSON.parse(await docker(['inspect', container])) as Array<{
      NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }>> }
    }>
    const binding = state.NetworkSettings.Ports['22/tcp']?.find((item) => item.HostIp === '127.0.0.1')
    if (!binding) throw new Error(`${name} 未分配本地 SSH 端口`)
    const target: DistroTarget = {
      name, host: '127.0.0.1', port: Number(binding.HostPort), keyPath,
      users: { root: 'root', admin: 'admin', ops: 'ops' }, adminPassword: TEST_PASSWORD
    }
    const deadline = Date.now() + 90_000
    let lastError: unknown
    let ready = false
    while (Date.now() < deadline) {
      try {
        const result = await execSsh(target, target.users.root, 'true', '', undefined, 5_000)
        if (result.code !== 0) throw new Error(result.stderr || 'SSH 就绪命令失败')
        ready = true
        break
      } catch (error) { lastError = error }
      if (await docker(['inspect', '--format', '{{.State.Running}}', container]) !== 'true') break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!ready) throw new Error(`${name} 的 sshd 未就绪：${String(lastError)}`)
    const startupMs = Math.round(performance.now() - started)
    const metrics = { name, ...image, startupMs, capturedAt: new Date().toISOString() }
    const reports = path.join(DISTRO_DIR, '.runs')
    await mkdir(reports, { recursive: true })
    await writeFile(path.join(reports, `${container}.json`), JSON.stringify(metrics, null, 2) + '\n')
    console.info(`${name}：${(image.bytes / 1024 / 1024).toFixed(1)} MiB，${image.architecture}，${image.cached ? '复用镜像' : `首次构建 ${image.buildMs} ms`}，启动 ${startupMs} ms`)
    return { ...target, stop }
  } catch (error) {
    if (created) {
      try { console.error(`${name} 启动日志：\n${await docker(['logs', '--tail', '60', container])}`) } catch { /* 保留原始错误 */ }
    }
    try { await stop() } catch (cleanupError) { console.error(`靶机清理失败：${String(cleanupError)}`) }
    throw error
  }
}

export function describeDistros(names: string[] | 'all', fn: (target: () => DistroTarget) => void): void {
  const reason = distroSkipReason()
  if (reason) console.info(reason)
  for (const name of names === 'all' ? DISTROS : names) {
    const targetReason = reason ?? distroSkipReason(name)
    if (targetReason && !reason) console.info(targetReason)
    describe.skipIf(Boolean(targetReason))(`发行版 ${name}`, () => {
      let target: Awaited<ReturnType<typeof startDistro>> | undefined
      beforeAll(async () => { target = await startDistro(name) })
      afterAll(async () => { await target?.stop() })
      fn(() => {
        if (!target) throw new Error(`${name} 尚未启动`)
        return target
      })
    })
  }
}
