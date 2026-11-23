/** Null preserves the application's established connection defaults. */
export function normalizeConnectionTimeout(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 120) {
    throw new Error('连接超时必须是 5 到 120 秒的整数')
  }
  return value
}

export function normalizeKeepaliveInterval(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 300) {
    throw new Error('心跳间隔必须是 0 到 300 秒的整数')
  }
  return value
}
