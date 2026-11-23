/** POSIX single-quote escaping for remote shell commands. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function shouldPackSmallFiles(
  files: { size: number }[],
  options: { minCount?: number; maxAvg?: number } = {}
): boolean {
  const minCount = options.minCount ?? 12
  const maxAvg = options.maxAvg ?? 64 * 1024
  if (files.length < minCount) return false
  const avg = files.reduce((sum, file) => sum + file.size, 0) / files.length
  return avg <= maxAvg
}

/** Only a part file with the current source fingerprint can be resumed. */
export function uploadRange(partSize: number | null, localTotal: number): { offset: number; done: boolean } {
  return resumeOffset(partSize, localTotal)
}

export function resumeOffset(partSize: number | null, total: number): { offset: number; done: boolean } {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('文件大小不合法')
  }
  if (partSize == null || !Number.isSafeInteger(partSize) || partSize < 0 || partSize > total) {
    return { offset: 0, done: false }
  }
  return { offset: partSize, done: partSize === total }
}
