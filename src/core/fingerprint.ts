import { createHash } from 'node:crypto'

/** OpenSSH SHA256 fingerprint of a raw host public key blob. */
export function fingerprintKey(key: Buffer): { fingerprint: string; keyType: string } {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  let keyType = 'ssh'
  if (key.length >= 4) {
    const len = key.readUInt32BE(0)
    if (len > 0 && len < 80 && key.length >= 4 + len) {
      const text = key.subarray(4, 4 + len).toString('utf8')
      if (/^[\x20-\x7e]+$/.test(text)) keyType = text
    }
  }
  return { fingerprint: `SHA256:${digest}`, keyType }
}

/** OpenSSH-style SHA256 fingerprint from the hex digest ssh2 reports. */
export function hexSha256ToOpenSsh(hex: string): string {
  const clean = hex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('指纹摘要不是合法的十六进制')
  }
  const raw = Buffer.from(clean, 'hex')
  const b64 = raw.toString('base64').replace(/=+$/, '')
  return `SHA256:${b64}`
}
