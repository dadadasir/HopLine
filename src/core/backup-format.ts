import { getSodium, type Sodium } from './sodium'

/** ASCII magic. The on-disk extension is `.hopline-backup`. */
export const BACKUP_MAGIC = 'HOPLINE'
export const BACKUP_VERSION = 2
export const KDF_ARGON2ID = 1

const MAGIC_BYTES = new TextEncoder().encode(BACKUP_MAGIC)
const SALT_LEN = 16
const NONCE_LEN = 24
export const HEADER_LEN = MAGIC_BYTES.length + 1 + 1 + 4 + 8 + SALT_LEN + NONCE_LEN

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupFormatError'
  }
}

export interface KdfParams {
  opslimit: number
  memlimit: number
  salt: Uint8Array
}

export interface ProductionKdf {
  opslimit: number
  memlimit: number
}

export function assertKdfParams(params: ProductionKdf): void {
  if (!Number.isInteger(params.opslimit) || params.opslimit < 1 || params.opslimit > 10 ||
      !Number.isInteger(params.memlimit) || params.memlimit < 8192 || params.memlimit > 1073741824) {
    throw new BackupFormatError('备份文件参数异常')
  }
}

export async function productionKdfParams(): Promise<ProductionKdf> {
  const sodium = await getSodium()
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
  }
}

export async function minimumKdfParams(): Promise<ProductionKdf> {
  const sodium = await getSodium()
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(len)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function writeHeader(params: KdfParams, nonce: Uint8Array): Uint8Array {
  assertKdfParams(params)
  if (params.salt.length !== SALT_LEN) {
    throw new BackupFormatError('salt 长度不正确')
  }
  if (nonce.length !== NONCE_LEN) {
    throw new BackupFormatError('nonce 长度不正确')
  }
  const header = new Uint8Array(HEADER_LEN)
  const view = new DataView(header.buffer)
  header.set(MAGIC_BYTES, 0)
  header[7] = BACKUP_VERSION
  header[8] = KDF_ARGON2ID
  view.setUint32(9, params.opslimit, true)
  view.setBigUint64(13, BigInt(params.memlimit), true)
  header.set(params.salt, 21)
  header.set(nonce, 37)
  return header
}

export interface ParsedHeader {
  version: number
  kdfId: number
  params: KdfParams
  nonce: Uint8Array
  aad: Uint8Array
  ciphertext: Uint8Array
}

export function parseBackup(file: Uint8Array): ParsedHeader {
  if (file.length < HEADER_LEN + 16) {
    throw new BackupFormatError('备份文件太短')
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (file[i] !== MAGIC_BYTES[i]) {
      throw new BackupFormatError('不是 Hopline 备份文件')
    }
  }
  const version = file[7]!
  if (version !== 1 && version !== BACKUP_VERSION) {
    throw new BackupFormatError(`不支持的备份版本: ${version}`)
  }
  const kdfId = file[8]!
  if (kdfId !== KDF_ARGON2ID) {
    throw new BackupFormatError('不支持的密钥派生算法')
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const opslimit = view.getUint32(9, true)
  const memlimit = Number(view.getBigUint64(13, true))
  assertKdfParams({ opslimit, memlimit })
  const salt = file.slice(21, 37)
  const nonce = file.slice(37, 61)
  const aad = file.slice(0, 37)
  const ciphertext = file.slice(HEADER_LEN)
  return {
    version,
    kdfId,
    params: { opslimit, memlimit, salt },
    nonce,
    aad,
    ciphertext
  }
}

async function derive(sodium: Sodium, password: string, params: KdfParams): Promise<Uint8Array> {
  assertKdfParams(params)
  return sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    password,
    params.salt,
    params.opslimit,
    params.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
}

export async function deriveBackupKey(password: string, params: KdfParams): Promise<Uint8Array> {
  if (!password) throw new BackupFormatError('主密码不能为空')
  const sodium = await getSodium()
  return derive(sodium, password, params)
}

export async function createKdfParams(
  overrides?: Partial<Pick<KdfParams, 'opslimit' | 'memlimit'>>
): Promise<KdfParams> {
  const sodium = await getSodium()
  const defaults = overrides?.memlimit
    ? {
        opslimit: overrides.opslimit ?? sodium.crypto_pwhash_OPSLIMIT_MIN,
        memlimit: overrides.memlimit
      }
    : await productionKdfParams()
  return {
    opslimit: overrides?.opslimit ?? defaults.opslimit,
    memlimit: overrides?.memlimit ?? defaults.memlimit,
    salt: sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  }
}

export async function encryptWithKey(
  plaintext: Uint8Array,
  key: Uint8Array,
  params: KdfParams
): Promise<Uint8Array> {
  const sodium = await getSodium()
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new BackupFormatError('密钥长度不正确')
  }
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const header = writeHeader(params, nonce)
  const aad = header.slice(0, 37)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    key
  )
  return concat([header, ciphertext])
}

export async function decryptWithKey(file: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const sodium = await getSodium()
  const parsed = parseBackup(file)
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      parsed.ciphertext,
      parsed.aad,
      parsed.nonce,
      key
    )
  } catch {
    throw new BackupFormatError('主密码不正确或备份文件已损坏')
  }
}

export async function encryptVault(
  plaintext: Uint8Array,
  password: string,
  overrides?: Partial<Pick<KdfParams, 'opslimit' | 'memlimit' | 'salt'>>
): Promise<{ file: Uint8Array; params: KdfParams; key: Uint8Array }> {
  const sodium = await getSodium()
  const params = await createKdfParams(overrides)
  if (overrides?.salt) {
    if (overrides.salt.length !== SALT_LEN) throw new BackupFormatError('salt 长度不正确')
    params.salt = overrides.salt
  }
  const key = await derive(sodium, password, params)
  const file = await encryptWithKey(plaintext, key, params)
  return { file, params, key }
}

export async function decryptVault(file: Uint8Array, password: string): Promise<Uint8Array> {
  const parsed = parseBackup(file)
  try {
    const key = await deriveBackupKey(password, parsed.params)
    return await decryptWithKey(file, key)
  } catch (error) {
    if (error instanceof BackupFormatError) throw error
    throw new BackupFormatError('主密码不正确或备份文件已损坏')
  }
}
