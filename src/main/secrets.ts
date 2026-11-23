import { safeStorage } from 'electron'
import type { SecretCodec } from '../core/vault'
import { getLoadedSodium } from '../core/sodium'
import { LockedError, type Locale } from '../shared/types'
import { KEYSTORE_UNREADABLE } from '../shared/host-secrets'

export { LockedError } from '../shared/types'
let secretKey: () => Uint8Array | null = () => null
const AAD = 'hopline-secret-v1'

export function setSecretKeyProvider(provider: typeof secretKey): void {
  secretKey = provider
}

function requireKey(): Uint8Array {
  const key = secretKey()
  if (!key) throw new LockedError()
  return key
}

/**
 * Host secrets are wrapped with the OS keystore via Electron safeStorage.
 * Without a keystore, use the unlocked master password's dedicated subkey.
 */
export function safeStorageAvailable(): boolean {
  // Test/acceptance switch: simulate a machine without an OS keystore.
  if (process.env.HOPLINE_DISABLE_KEYSTORE === '1') return false
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export class KeystoreReadError extends Error {
  constructor(locale: Locale = 'zh') {
    super(KEYSTORE_UNREADABLE[locale])
  }
}

function decryptWithKeystore(sealed: Buffer, locale?: Locale): string {
  if (safeStorageAvailable()) {
    try {
      return safeStorage.decryptString(sealed)
    } catch { /* The system can deny decryption even when encryption is available. */ }
  }
  throw new KeystoreReadError(locale)
}

export function createSafeCodec(locale: () => Locale = () => 'zh'): SecretCodec {
  return {
    encrypt(plain: string) {
      if (safeStorageAvailable()) {
        try {
          return `safe:${safeStorage.encryptString(plain).toString('base64')}`
        } catch {
          throw new KeystoreReadError(locale())
        }
      }
      const key = requireKey()
      const sodium = getLoadedSodium()
      const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
      const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, AAD, null, nonce, key)
      return `mp:${Buffer.concat([nonce, encrypted]).toString('base64')}`
    },
    decrypt(payload: string) {
      if (payload.startsWith('mp:')) {
        const key = requireKey()
        const sodium = getLoadedSodium()
        const bytes = Buffer.from(payload.slice(3), 'base64')
        const size = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
        const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(size), AAD, bytes.subarray(0, size), key)
        return Buffer.from(plain).toString('utf8')
      }
      if (payload.startsWith('safe:')) {
        return decryptWithKeystore(Buffer.from(payload.slice(5), 'base64'), locale())
      }
      if (payload.startsWith('plain:')) {
        return Buffer.from(payload.slice(6), 'base64').toString('utf8')
      }
      throw new Error('无法解密已保存的密钥')
    }
  }
}

export function sealKey(key: Uint8Array): Buffer {
  const encoded = Buffer.from(key).toString('base64')
  if (!safeStorageAvailable()) {
    throw new Error('当前系统钥匙串不可用，无法在本机记住解锁状态')
  }
  try {
    return safeStorage.encryptString(encoded)
  } catch {
    throw new KeystoreReadError()
  }
}

export function openKey(sealed: Buffer): Uint8Array {
  const encoded = decryptWithKeystore(sealed)
  return new Uint8Array(Buffer.from(encoded, 'base64'))
}

export function reencryptMasterSecret(payload: string, oldKey: Uint8Array, newKey: Uint8Array): string {
  const sodium = getLoadedSodium()
  const bytes = Buffer.from(payload.slice(3), 'base64')
  const size = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(size), AAD, bytes.subarray(0, size), oldKey)
  try {
    const nonce = sodium.randombytes_buf(size)
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, AAD, null, nonce, newKey)
    return `mp:${Buffer.concat([nonce, encrypted]).toString('base64')}`
  } finally {
    sodium.memzero(plain)
  }
}
