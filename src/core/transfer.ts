import { createHash } from 'node:crypto'

export function transferPartName(filename: string, size: number, mtime: number): string {
  const fingerprint = createHash('sha256').update(`${size}:${mtime}`).digest('hex').slice(0, 16)
  return `.${filename}.${fingerprint}.hopline-part`
}

export function isTransferPart(filename: string, candidate: string): boolean {
  return transferPartTarget(candidate) === filename
}

export function transferPartTarget(candidate: string): string | null {
  return /^\.([\s\S]+)\.[a-f0-9]{16}\.hopline-part$/.exec(candidate)?.[1] ?? null
}

export interface RemoteVersion {
  size: number
  mtime: number
}

export function sameRemoteVersion(baseline: RemoteVersion, current: RemoteVersion | null): boolean {
  return current !== null && baseline.size === current.size && baseline.mtime === current.mtime
}
