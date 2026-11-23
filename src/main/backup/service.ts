import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { encryptWithKey, decryptWithKey, decryptVault, deriveBackupKey, createKdfParams, assertKdfParams, type KdfParams } from '../../core/backup-format'
import { selectBackupsToPrune } from '../../core/backup-prune'
import { getSodium } from '../../core/sodium'
import { S3CompatibleStub } from '../../core/s3'
import { Vault, assertPortable, type PortableVault, type PortableVaultV1 } from '../../core/vault'
import { WebDavClient } from '../../core/webdav'
import { renameReplaceSync } from '../../core/win-platform'
import type { BackupStatus, LocalBackup } from '../../shared/types'
import { openKey, sealKey, reencryptMasterSecret, KeystoreReadError } from '../secrets'
import { logError, logInfo } from '../logger'

const TOKEN = new TextEncoder().encode('hopline-vault-ok')
const MAX_BYTES = 64 * 1024 * 1024
const WEBDAV_TIMEOUT_MS = 120_000

export class BackupService {
  private key: Uint8Array | null = null
  private hostKey: Uint8Array | null = null
  private unlockListeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null
  private lastBackupTime = 0
  private passwordBusy = false
  private webdavActive: { requestId: string; controller: AbortController } | null = null

  secretKey(): Uint8Array | null { return this.hostKey }

  /** Synchronous secret-migration hook; set/unlock include its vault edits in their save. */
  onUnlocked(listener: () => void): () => void {
    this.unlockListeners.add(listener)
    return () => { this.unlockListeners.delete(listener) }
  }

  private async acceptKey(key: Uint8Array): Promise<void> {
    const sodium = await getSodium()
    this.hostKey = sodium.crypto_kdf_derive_from_key(32, 1, 'hlsecret', key)
    this.key = key
    this.unlockListeners.forEach((listener) => listener())
  }

  constructor(
    private readonly vault: Vault,
    private readonly directory: string,
    private readonly keyFile: string,
    private readonly save: () => void
  ) {}

  async init(): Promise<void> {
    if (!this.vault.snapshot().settings.backup.rememberUnlock) return
    if (!this.vault.verifier() || !fs.existsSync(this.keyFile)) return
    try {
      const sealed = fs.readFileSync(this.keyFile)
      const key = openKey(sealed)
      await decryptWithKey(Buffer.from(this.vault.verifier()!, 'base64'), key)
      await this.acceptKey(key)
      logInfo('restored backup unlock from the OS keystore')
    } catch (error) {
      logError('could not restore backup unlock', error)
      if (!(error instanceof KeystoreReadError)) await this.wipe()
    }
  }

  status(): BackupStatus {
    const backup = this.vault.snapshot().settings.backup
    return {
      hasPassword: Boolean(backup.kdf && backup.verifier),
      unlocked: this.key !== null,
      rememberUnlock: backup.rememberUnlock,
      lastAutoBackupAt: backup.lastAutoBackupAt,
      autoBackupNote: this.key ? null : backup.kdf ? '自动备份已暂停，等待主密码解锁' : '设置主密码后才会生成加密备份'
    }
  }

  async setPassword(password: string, remember: boolean): Promise<BackupStatus> {
    return this.passwordOperation(async () => {
      if (this.vault.kdf()) throw new Error('已设置主密码，请解锁或更换主密码')
      assertPassword(password)
      let key: Uint8Array | undefined
      try {
        const params = await createKdfParams()
        key = await deriveBackupKey(password, params)
        const verifier = await encryptWithKey(TOKEN, key, params)
        await this.holdUnlock(key, remember, () => {
          if (this.vault.kdf()) throw new Error('主密码状态已改变，请重试')
          this.vault.setBackupUnlock(
            { opslimit: params.opslimit, memlimit: params.memlimit, salt: Buffer.from(params.salt).toString('base64') },
            Buffer.from(verifier).toString('base64')
          )
        })
        return this.status()
      } finally {
        if (key !== this.key) key?.fill(0)
      }
    })
  }

  async unlock(password: string, remember: boolean): Promise<BackupStatus> {
    return this.passwordOperation(async () => {
      assertPassword(password)
      const params = this.params()
      const verifier = this.vault.verifier()
      if (!params || !verifier) throw new Error('还没有设置主密码')
      const expectedKdf = JSON.stringify(this.vault.kdf())
      let key: Uint8Array | undefined
      try {
        key = await deriveBackupKey(password, params)
        try {
          const opened = await decryptWithKey(Buffer.from(verifier, 'base64'), key)
          if (Buffer.from(opened).toString('utf8') !== 'hopline-vault-ok') throw new Error()
        } catch { throw new Error('主密码不正确') }
        await this.holdUnlock(key, remember, () => {
          if (this.vault.verifier() !== verifier || JSON.stringify(this.vault.kdf()) !== expectedKdf) {
            throw new Error('主密码状态已改变，请重试')
          }
        })
        return this.status()
      } finally {
        if (key !== this.key) key?.fill(0)
      }
    })
  }

  async lock(): Promise<BackupStatus> {
    return this.passwordOperation(async () => {
      await this.wipe()
      this.forgetFile()
      return this.status()
    })
  }

  private async passwordOperation<T>(task: () => Promise<T>): Promise<T> {
    if (this.passwordBusy) throw new Error('主密码操作正在进行，请稍后重试')
    this.passwordBusy = true
    try { return await task() } finally { this.passwordBusy = false }
  }

  async changePassword(current: string, next: string, remember: boolean): Promise<BackupStatus> {
    return this.passwordOperation(async () => {
      const params = this.params(), verifier = this.vault.verifier()
      if (!params || !verifier) throw new Error('还没有设置主密码')
      let oldKey: Uint8Array | undefined, newKey: Uint8Array | undefined
      let oldHostKey: Uint8Array | undefined
      try {
        try {
          assertPassword(current)
          oldKey = await deriveBackupKey(current, params)
          const opened = await decryptWithKey(Buffer.from(verifier, 'base64'), oldKey)
          if (Buffer.from(opened).toString('utf8') !== 'hopline-vault-ok') throw new Error()
        } catch { throw new Error('主密码不正确') }
        assertPassword(next)
        if (current === next) throw new Error('新主密码不能与当前主密码相同')
        const nextParams = await createKdfParams()
        newKey = await deriveBackupKey(next, nextParams)
        const nextVerifier = Buffer.from(await encryptWithKey(TOKEN, newKey, nextParams)).toString('base64')
        const sodium = await getSodium()
        oldHostKey = sodium.crypto_kdf_derive_from_key(32, 1, 'hlsecret', oldKey)
        await this.hold(newKey, remember, (newHostKey) => {
          if (this.vault.verifier() !== verifier) throw new Error('主密码状态已改变，请重试')
          this.vault.changeMasterPassword(
            (payload) => reencryptMasterSecret(payload, oldHostKey!, newHostKey),
            { ...nextParams, salt: Buffer.from(nextParams.salt).toString('base64') }, nextVerifier, remember, this.save
          )
        })
        return this.status()
      } finally {
        oldKey?.fill(0)
        oldHostKey?.fill(0)
        if (newKey !== this.key) newKey?.fill(0)
      }
    })
  }

  scheduleAuto(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.auto().catch((error) => logError('auto backup failed', error))
    }, 1500)
  }

  async auto(): Promise<string | null> {
    if (!this.key) return null
    const name = await this.writeLocal()
    this.vault.markAutoBackup(Date.now())
    this.save()
    logInfo(`auto backup ${name}`)
    return name
  }

  async exportTo(filePath: string, password: string | null): Promise<string> {
    const bytes = await this.encryptPayload(password)
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const file = await fs.promises.open(filePath, 'w', 0o600)
    try {
      await file.chmod(0o600)
      await file.writeFile(bytes)
    } finally {
      await file.close()
    }
    return filePath
  }

  async importFrom(filePath: string, password: string | null, mode: 'merge' | 'replace'): Promise<void> {
    const file = await readLimited(filePath)
    const payload = await this.decryptPayload(file, password)
    this.commitRestore(payload, mode)
  }

  async listLocal(): Promise<LocalBackup[]> {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const names = (await fs.promises.readdir(this.directory)).filter((name) => name.endsWith('.hopline-backup'))
    const files = await Promise.all(
      names.map(async (name) => {
        const filePath = path.join(this.directory, name)
        const stat = await fs.promises.stat(filePath)
        return { name, filePath, bytes: stat.size, mtimeMs: stat.mtimeMs }
      })
    )
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async webdav(direction: 'push' | 'pull', password: string | null, mode: 'merge' | 'replace', requestId: string = randomUUID()): Promise<void> {
    if (this.webdavActive) throw new Error('backup.webdavBusy')
    const controller = new AbortController(), deadline = performance.now() + WEBDAV_TIMEOUT_MS
    this.webdavActive = { requestId, controller }
    const timer = setTimeout(() => controller.abort(new Error('backup.webdavTimeout')), WEBDAV_TIMEOUT_MS)
    const check = () => {
      // Crypto and synchronous work can delay timers. A monotonic deadline also
      // guards every next phase after the event loop becomes available again.
      if (!controller.signal.aborted && performance.now() >= deadline) controller.abort(new Error('backup.webdavTimeout'))
      controller.signal.throwIfAborted()
    }
    try {
      const client = this.webdavClient({ signal: controller.signal, check })
      if (direction === 'push') {
        const bytes = await this.encryptPayload(password, check)
        check()
        await client.put(this.nextBackupName(), bytes)
        return
      }
      const entries = await client.list()
      check()
      const backups = entries
        .filter((entry) => /^\d{14}(?:\d{3})?\.hopline-backup$/.test(entry.name))
        .sort((a, b) => a.name === b.name ? 0 : a.name < b.name ? 1 : -1)
      const newest = backups[0]
      if (!newest) throw new Error('WebDAV 上还没有 Hopline 备份')
      const file = await client.get(newest.name)
      check()
      const payload = await this.decryptPayload(file, password)
      check()
      // This synchronous transaction is the commit point. Do not check cancel
      // or timeout afterwards: a completed restore must be reported as success.
      this.commitRestore(payload, mode)
    } catch (error) { check(); throw error }
    finally { clearTimeout(timer); this.webdavActive = null }
  }

  cancelWebdav(requestId: string): void {
    if (this.webdavActive?.requestId === requestId) this.webdavActive.controller.abort(new Error('backup.webdavCanceled'))
  }

  private commitRestore(payload: PortableVault | PortableVaultV1, mode: 'merge' | 'replace'): void {
    // Capture the current vault only after asynchronous reading/decryption. A
    // failed save must restore it before any later ordinary save can observe it.
    this.vault.transaction(() => {
      this.vault.importPortable(payload, mode)
      this.save()
    })
  }

  s3Describe(): string {
    const s3 = this.vault.snapshot().settings.backup.s3
    if (!s3) return ''
    return new S3CompatibleStub({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: '',
      prefix: s3.prefix,
      forcePathStyle: s3.forcePathStyle
    }).describe()
  }

  private webdavClient(operation: { signal: AbortSignal; check: () => void }): WebDavClient {
    const webdav = this.vault.snapshot().settings.backup.webdav
    const password = this.vault.webdavPassword()
    if (!webdav?.url || !webdav.username || !password) throw new Error('请先填写完整的 WebDAV 地址、用户名和密码')
    return new WebDavClient({
      url: webdav.url,
      username: webdav.username,
      password,
      remoteDir: webdav.remoteDir || 'hopline'
    }, operation)
  }

  private nextBackupName(): string {
    this.lastBackupTime = Math.max(Date.now(), this.lastBackupTime + 1)
    return `${stamp(new Date(this.lastBackupTime))}.hopline-backup`
  }

  private async writeLocal(): Promise<string> {
    const bytes = await this.encryptPayload(null)
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (;;) {
      const name = this.nextBackupName()
      try {
        await fs.promises.writeFile(path.join(this.directory, name), bytes, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      await this.prune()
      return name
    }
  }

  private async prune(): Promise<void> {
    const files = await this.listLocal()
    const doomed = selectBackupsToPrune(
      files.map((file) => ({ name: file.name, mtimeMs: file.mtimeMs })),
      Date.now()
    )
    await Promise.all(doomed.map((name) => fs.promises.unlink(path.join(this.directory, name)).catch(() => undefined)))
  }

  private async encryptPayload(password: string | null, check: () => void = () => {}): Promise<Uint8Array> {
    const plaintext = Buffer.from(JSON.stringify(this.vault.exportPortable()), 'utf8')
    if (password) {
      const encrypt = async () => {
        const existing = this.params()
        const encrypted = await (existing
          ? encryptWithDerived(plaintext, password, existing)
          : createAndEncrypt(plaintext, password))
        try {
          check()
          if (!existing) {
            const verifier = Buffer.from(await encryptWithKey(TOKEN, encrypted.key, encrypted.params)).toString('base64')
            await this.holdUnlock(encrypted.key, this.vault.snapshot().settings.backup.rememberUnlock, () => {
              check()
              if (this.vault.kdf()) throw new Error('主密码状态已改变，请重试')
              this.vault.setBackupUnlock({
                opslimit: encrypted.params.opslimit,
                memlimit: encrypted.params.memlimit,
                salt: Buffer.from(encrypted.params.salt).toString('base64')
              }, verifier)
            })
          }
          return encrypted.file
        } finally {
          if (encrypted.key !== this.key) encrypted.key.fill(0)
        }
      }
      // A first export implicitly sets the master password and must use the same lock.
      return this.params() ? encrypt() : this.passwordOperation(encrypt)
    }
    const params = this.params()
    if (!this.key || !params) throw new Error('请先解锁备份主密码')
    // Lock/rotation may erase the held buffer while encryption awaits sodium.
    const key = this.key.slice()
    try { return await encryptWithKey(plaintext, key, params) }
    finally { key.fill(0) }
  }

  private async decryptPayload(file: Uint8Array, password: string | null): Promise<PortableVault | PortableVaultV1> {
    let plain: Uint8Array
    if (password) plain = await decryptVault(file, password)
    else if (this.key) {
      const key = this.key.slice()
      try { plain = await decryptWithKey(file, key) }
      catch { throw new Error('这个备份可能是用旧主密码加密的，请输入当时的主密码') }
      finally { key.fill(0) }
    }
    else throw new Error('需要主密码才能恢复备份')
    const parsed = JSON.parse(Buffer.from(plain).toString('utf8')) as unknown
    assertPortable(parsed)
    return parsed
  }

  private params(): KdfParams | null {
    const kdf = this.vault.kdf()
    if (!kdf) return null
    assertKdfParams(kdf)
    return {
      opslimit: kdf.opslimit,
      memlimit: kdf.memlimit,
      salt: new Uint8Array(Buffer.from(kdf.salt, 'base64'))
    }
  }

  private async hold(key: Uint8Array, remember: boolean, commit: (hostKey: Uint8Array) => void): Promise<void> {
    const sodium = await getSodium()
    const hostKey = sodium.crypto_kdf_derive_from_key(32, 1, 'hlsecret', key)
    let staged: string | undefined, previous = false, installed = false
    try {
      if (remember || fs.existsSync(this.keyFile)) {
        const sealed = remember ? sealKey(key) : null
        fs.mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 })
        staged = fs.mkdtempSync(`${this.keyFile}.`)
        if (sealed) {
          const fd = fs.openSync(path.join(staged, 'next'), 'wx', 0o600)
          try {
            fs.writeFileSync(fd, sealed)
            fs.fsyncSync(fd)
          } finally { fs.closeSync(fd) }
        }
        if (fs.existsSync(this.keyFile)) {
          renameReplaceSync(this.keyFile, path.join(staged, 'previous'))
          previous = true
        }
        if (sealed) {
          renameReplaceSync(path.join(staged, 'next'), this.keyFile)
          installed = true
        }
      }
      // The vault save is synchronous: no caller can observe a partial rotation.
      commit(hostKey)
    } catch (error) {
      hostKey.fill(0)
      if (previous) renameReplaceSync(path.join(staged!, 'previous'), this.keyFile)
      else if (installed) fs.unlinkSync(this.keyFile)
      if (staged) fs.rmSync(staged, { recursive: true, force: true })
      throw error
    }
    this.key?.fill(0)
    this.hostKey?.fill(0)
    this.key = key
    this.hostKey = hostKey
    if (staged) {
      try { fs.rmSync(staged, { recursive: true, force: true }) }
      catch { logError('could not remove staged backup key') }
    }
  }

  private async holdUnlock(key: Uint8Array, remember: boolean, update: () => void): Promise<void> {
    await this.hold(key, remember, (hostKey) => this.vault.transaction(() => {
      update()
      this.vault.updateSettings({ rememberUnlock: remember })
      const previous = this.hostKey
      // The migration codec must see the candidate subkey, but there is no await
      // between exposing it, applying migrations and saving the entire vault.
      this.hostKey = hostKey
      try {
        this.unlockListeners.forEach((listener) => listener())
        this.save()
      } finally { this.hostKey = previous }
    }))
  }

  private async wipe(): Promise<void> {
    const key = this.key
    this.key = null
    this.hostKey?.fill(0)
    this.hostKey = null
    if (!key) return
    try {
      const sodium = await getSodium()
      sodium.memzero(key)
    } catch {
      key.fill(0)
    }
  }

  private forgetFile(): void {
    if (fs.existsSync(this.keyFile)) fs.unlinkSync(this.keyFile)
  }
}

function assertPassword(password: string): void {
  if (password.length < 8) throw new Error('主密码至少 8 位')
  if (password.length > 200) throw new Error('主密码过长')
}

async function encryptWithDerived(plaintext: Uint8Array, password: string, params: KdfParams) {
  const key = await deriveBackupKey(password, params)
  try { return { file: await encryptWithKey(plaintext, key, params), key, params } }
  catch (error) { key.fill(0); throw error }
}

async function createAndEncrypt(plaintext: Uint8Array, password: string) {
  const params = await createKdfParams()
  return encryptWithDerived(plaintext, password, params)
}

async function readLimited(filePath: string): Promise<Uint8Array> {
  const stat = await fs.promises.stat(filePath)
  if (stat.size > MAX_BYTES) throw new Error('备份文件过大')
  return new Uint8Array(await fs.promises.readFile(filePath))
}

// Older backup names used local time; the first mixed listing after upgrading may
// differ by a few hours. New names consistently use UTC across devices and DST.
function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${String(date.getUTCMilliseconds()).padStart(3, '0')}`
}
