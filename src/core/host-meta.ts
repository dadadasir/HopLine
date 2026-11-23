import { currencyCode } from './currency'
import type { HostMeta } from '../shared/types'

export function emptyHostMeta(): HostMeta {
  return { provider: null, price: null, currency: null, billingCycle: null, renewAt: null, tags: [], note: null }
}

export function applyHostMeta(current: HostMeta, patch: Partial<HostMeta> | undefined): HostMeta {
  const result = structuredClone(current)
  if (patch === undefined) return result
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('资产信息格式不正确')
  for (const key of [...Object.keys(result).filter(key => key !== 'renewalAnchorDay'), 'renewalAnchorDay'] as (keyof HostMeta)[]) {
    const value = patch[key]
    if (value === undefined) continue
    switch (key) {
      case 'provider':
      case 'note': {
        const label = key === 'provider' ? '厂商' : '备注'
        const max = key === 'provider' ? 40 : 2000
        if (value !== null && (typeof value !== 'string' || value.length > max)) {
          throw new Error(`${label}必须是不超过 ${max} 字符的文本`)
        }
        result[key] = value as string | null
        break
      }
      case 'price':
        if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1e9)) {
          throw new Error('价格必须是 0 到 1000000000 的整数')
        }
        result.price = value as number | null
        break
      case 'currency':
        result.currency = value === null ? null : currencyCode(value)
        break
      case 'billingCycle':
        if (value !== null && !['monthly', 'quarterly', 'yearly', 'once'].includes(value as string)) {
          throw new Error('计费周期不正确')
        }
        result.billingCycle = value as HostMeta['billingCycle']
        break
      case 'renewAt':
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
          throw new Error('续费日期必须是有效的毫秒时间戳')
        }
        result.renewAt = value as number | null
        break
      case 'renewalAnchorDay':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) throw new Error('续费锚点日不正确')
        result.renewalAnchorDay = value
        break
      case 'tags': {
        if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string')) throw new Error('标签必须是文本数组')
        const tags = [...new Set(value.map((tag: string) => tag.trim()))]
        if (tags.some((tag) => tag.length > 24)) throw new Error('每个标签最长 24 字符')
        if (tags.length > 20) throw new Error('标签最多 20 个')
        result.tags = tags
        break
      }
    }
  }
  if (patch.renewAt !== undefined && patch.renewAt !== current.renewAt && patch.renewalAnchorDay === undefined) delete result.renewalAnchorDay
  return result
}

/** Disk recovery must never reject a host just because its asset metadata is bad. */
export function recoverHostMeta(value: unknown): HostMeta {
  try {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'currency' in value && value.currency != null) {
      try { currencyCode(value.currency) } catch { value = { ...value, currency: null } }
    }
    return applyHostMeta(emptyHostMeta(), value as Partial<HostMeta>)
  } catch {
    return emptyHostMeta()
  }
}

/** Strict on saves; legacy disk/backup metadata can still be recovered without discarding hosts. */
export function pricedHostMeta(current: HostMeta, patch: Partial<HostMeta> | undefined): HostMeta {
  const result = applyHostMeta(current, patch)
  if (result.price !== null && (!result.currency || !result.billingCycle) &&
      ['price', 'currency', 'billingCycle'].some(key => result[key as keyof HostMeta] !== current[key as keyof HostMeta])) throw new Error('填写价格时，请同时填写币种和计费周期')
  return result
}
