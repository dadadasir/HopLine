import crypto from 'node:crypto'
import { connectionCard } from '../core/connection-info'
import type { Vault } from '../core/vault'
import type { HostSecretField } from '../shared/host-secrets'

export const CONCEALED_FORMAT = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"'
export const OWNER_FORMAT = 'electron application/osclipboard;format="org.hopline.secret-owner"'
export const SECRET_CLIPBOARD_MS = 60_000
export const SECRET_AUTH_MS = 5 * 60_000
export const SECRET_DISPOSE_MS = 1000
interface Options {
  vault: Vault
  checkKeystore?: (payload: string | null) => void
  locked: () => boolean
  canPromptTouchID: () => boolean
  promptTouchID: (reason: string) => Promise<void>
  clipboard: {
    write: (text: string, token: string) => Promise<void>
    matches: (text: string, token: string) => Promise<boolean>
    clear: () => void
  }
  now?: () => number
}

export function secretField(value: unknown): HostSecretField {
  const fields = ['password', 'passphrase', 'proxyPassword']
  if (typeof value === 'string' && fields.includes(value)) return value as HostSecretField
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>
    if (Object.keys(item).length === 2 && Object.hasOwn(item, 'jumpIndex') && Object.hasOwn(item, 'field') && Number.isInteger(item.jumpIndex) && Number(item.jumpIndex) >= 0 && Number(item.jumpIndex) < 5 &&
        (item.field === 'password' || item.field === 'passphrase')) return item as HostSecretField
  }
  throw new Error('凭据字段不合法 / Invalid credential field')
}

/** Decrypt only after authentication. Copied text lives only until its clipboard deadline. */
export class HostSecrets {
  private verifiedUntil = 0
  private verifying?: Promise<void>
  private clipboardTimer?: ReturnType<typeof setTimeout>
  private clipboardGeneration = 0
  private ownedClipboard?: { text: string; token: string }
  private pendingWrite: Promise<void> = Promise.resolve()
  private disposal?: Promise<void>
  private disposed = false
  private cleanupFinished = false
  constructor(private readonly options: Options) {}
  resetVerification(): void { this.verifiedUntil = 0 }
  private unlocked(): void {
    if (this.options.locked()) { this.resetVerification(); throw new Error('主机库已锁定，请先解锁 / Host library is locked') }
  }
  private host(id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('主机标识不合法 / Invalid host ID')
    const host = this.options.vault.getHost(id)
    if (!host) throw new Error('主机不存在 / Host not found')
    return host
  }
  async authorize(checkCaller: () => void): Promise<void> {
    this.active()
    this.unlocked()
    const now = this.options.now ?? Date.now
    if (this.options.vault.settingsPublic(true).verifySecrets && now() >= this.verifiedUntil && this.options.canPromptTouchID()) {
      if (!this.verifying) {
        const reason = this.options.vault.settingsPublic(true).language === 'zh' ? '查看或复制已保存的凭据' : 'view or copy saved credentials'
        this.verifying = this.options.promptTouchID(reason).then(() => { this.verifiedUntil = now() + SECRET_AUTH_MS })
          .catch(() => { throw new Error('身份验证未通过 / Authentication failed') }).finally(() => { this.verifying = undefined })
      }
      await this.verifying
    }
    checkCaller()
    this.active()
    this.unlocked()
  }
  private async read(id: unknown, rawField: unknown, checkCaller: () => void): Promise<string> {
    const host = this.host(id), field = secretField(rawField)
    this.active()
    this.options.checkKeystore?.(this.options.vault.hostSecretPayload(host.id, field))
    await this.authorize(checkCaller)
    const value = this.options.vault.readHostSecret(host.id, field)
    if (value == null) throw new Error('未保存此凭据 / Credential not saved')
    return value
  }
  reveal(id: unknown, rawField: unknown, checkCaller: () => void): Promise<string> {
    return this.read(id, rawField, checkCaller)
  }
  async copy(id: unknown, rawField: unknown, checkCaller: () => void): Promise<void> {
    await this.write(await this.read(id, rawField, checkCaller))
  }
  async copyConnectionCard(id: unknown, checkCaller: () => void): Promise<void> {
    const host = this.host(id)
    this.active()
    this.options.checkKeystore?.(this.options.vault.hostSecretPayload(host.id, 'password'))
    await this.authorize(checkCaller)
    const current = this.host(host.id)
    const password = this.options.vault.readHostSecret(current.id, 'password')
    await this.write(connectionCard(current, password, this.options.vault.settingsPublic(true).language))
  }
  private active(): void {
    if (this.disposed) throw new Error('应用正在退出 / Application is quitting')
  }
  private async clearOwnedClipboard(generation = this.clipboardGeneration): Promise<void> {
    const item = this.ownedClipboard
    if (!item) return
    try {
      const matches = await this.options.clipboard.matches(item.text, item.token)
      if (matches && generation === this.clipboardGeneration && this.ownedClipboard === item) this.options.clipboard.clear()
    } catch { /* An unavailable or changed clipboard must never be cleared. */ }
    finally { if (generation === this.clipboardGeneration && this.ownedClipboard === item) this.ownedClipboard = undefined }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.resetVerification()
    this.disposal = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.pendingWrite.then(() => this.clearOwnedClipboard()),
          new Promise<void>(resolve => { deadline = setTimeout(resolve, SECRET_DISPOSE_MS) })
        ])
      } finally {
        this.cleanupFinished = true
        ++this.clipboardGeneration
        this.ownedClipboard = undefined
        clearTimeout(deadline)
        clearTimeout(this.clipboardTimer); this.clipboardTimer = undefined
      }
    })()
    return this.disposal
  }
  private write(text: string): Promise<void> {
    this.active()
    const token = crypto.randomUUID()
    const writing = this.pendingWrite.then(async () => {
      if (this.cleanupFinished) return
      await this.options.clipboard.write(text, token)
      if (this.cleanupFinished) return
      const generation = ++this.clipboardGeneration
      clearTimeout(this.clipboardTimer)
      this.ownedClipboard = { text, token }
      if (this.disposed) return
      this.clipboardTimer = setTimeout(() => {
        if (!this.disposed) void this.clearOwnedClipboard(generation)
      }, SECRET_CLIPBOARD_MS)
      this.clipboardTimer.unref?.()
    })
    this.pendingWrite = writing.catch(() => {})
    return writing
  }
}
