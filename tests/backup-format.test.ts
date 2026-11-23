import { describe, expect, it, vi } from 'vitest'
import { getSodium } from '../src/core/sodium'
import {
  BACKUP_MAGIC,
  BACKUP_VERSION,
  HEADER_LEN,
  BackupFormatError,
  decryptVault,
  decryptWithKey,
  encryptVault,
  encryptWithKey,
  minimumKdfParams,
  parseBackup
} from '../src/core/backup-format'

const text = new TextEncoder()
const read = new TextDecoder()

async function fastEncrypt(payload: string, password: string) {
  const kdf = await minimumKdfParams()
  return encryptVault(text.encode(payload), password, kdf)
}

describe('backup format', () => {
  it.each([
    [1, 2 ** 40], [1000, 8192], [0, 8192], [1, 8191], [11, 8192], [1, 1073741825]
  ])('rejects unsafe KDF values %s/%s before deriving a key', async (opslimit, memlimit) => {
    const { file } = await fastEncrypt('secret', 'master-password')
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    view.setUint32(9, opslimit, true)
    view.setBigUint64(13, BigInt(memlimit), true)
    const sodium = await getSodium()
    const derive = vi.spyOn(sodium, 'crypto_pwhash').mockImplementation(() => { throw new Error('不应派生密钥') })
    try {
      await expect(decryptVault(file, 'master-password')).rejects.toThrow('备份文件参数异常')
      expect(derive).not.toHaveBeenCalled()
    } finally {
      derive.mockRestore()
    }
  })

  it.each([[1, 8192], [10, 1073741824]])('accepts KDF boundary values %s/%s without deriving', async (opslimit, memlimit) => {
    const { file } = await fastEncrypt('secret', 'master-password')
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    view.setUint32(9, opslimit, true)
    view.setBigUint64(13, BigInt(memlimit), true)
    expect(parseBackup(file).params).toMatchObject({ opslimit, memlimit })
  })

  it('writes a versioned Hopline header and round-trips with the password', async () => {
    const payload = JSON.stringify({ kind: 'hopline-vault', hosts: [{ name: 'edge' }] })
    const { file, params } = await fastEncrypt(payload, 'correct horse battery')
    expect(Buffer.from(file.subarray(0, 7)).toString('ascii')).toBe(BACKUP_MAGIC)
    expect(file[7]).toBe(BACKUP_VERSION)
    expect(file[8]).toBe(1)
    expect(file.length).toBeGreaterThan(HEADER_LEN)
    const parsed = parseBackup(file)
    expect(parsed.params.opslimit).toBe(params.opslimit)
    expect(parsed.params.memlimit).toBe(params.memlimit)
    expect(Buffer.from(parsed.params.salt)).toEqual(Buffer.from(params.salt))
    const opened = await decryptVault(file, 'correct horse battery')
    expect(read.decode(opened)).toBe(payload)
    expect(Buffer.from(file).toString('utf8')).not.toContain('correct horse battery')
    expect(Buffer.from(file).toString('utf8')).not.toContain('edge')
  })

  it('decrypts legacy v1 containers while writing v2, with the version authenticated', async () => {
    const plaintext = text.encode('legacy-vault')
    const { file, key } = await fastEncrypt('legacy-vault', 'password')
    expect(file[7]).toBe(2)
    const legacyHeader = file.slice(0, HEADER_LEN)
    legacyHeader[7] = 1
    const sodium = await getSodium()
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext, legacyHeader.slice(0, 37), null, legacyHeader.slice(37), key
    )
    const legacy = Buffer.concat([legacyHeader, ciphertext])
    expect(parseBackup(legacy).version).toBe(1)
    expect(read.decode(await decryptVault(legacy, 'password'))).toBe('legacy-vault')
    const tampered = new Uint8Array(file)
    tampered[7] = 1
    await expect(decryptWithKey(tampered, key)).rejects.toThrow('损坏')
  })

  it('rejects a wrong password', async () => {
    const { file } = await fastEncrypt('{"ok":true}', 'master-password')
    await expect(decryptVault(file, 'other-password')).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('rejects a tampered ciphertext', async () => {
    const { file, key } = await fastEncrypt('secret-hosts', 'master-password')
    const tampered = new Uint8Array(file)
    tampered[tampered.length - 1] ^= 0xff
    await expect(decryptWithKey(tampered, key)).rejects.toThrow(/损坏/)
  })

  it('rejects a tampered header parameter', async () => {
    const { file } = await fastEncrypt('secret-hosts', 'master-password')
    const tampered = new Uint8Array(file)
    tampered[9] ^= 0x01
    await expect(decryptVault(tampered, 'master-password')).rejects.toBeInstanceOf(BackupFormatError)
  })

  it('rejects a foreign magic and a future version', async () => {
    const { file, key, params } = await fastEncrypt('x', 'pw-123456')
    const badMagic = new Uint8Array(file)
    badMagic[0] = 0x58
    expect(() => parseBackup(badMagic)).toThrow(/不是 Hopline/)
    const future = new Uint8Array(file)
    future[7] = 9
    expect(() => parseBackup(future)).toThrow(/版本/)
    const again = await encryptWithKey(text.encode('x'), key, params)
    expect(parseBackup(again).nonce).not.toEqual(parseBackup(file).nonce)
  })

  it('rejects a truncated file', () => {
    expect(() => parseBackup(text.encode('HOPLINE'))).toThrow(/太短/)
  })
})
