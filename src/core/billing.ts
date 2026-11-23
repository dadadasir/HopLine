import type { HostPublic } from '../shared/types'
import type { FxSnapshot } from '../shared/fx'
import { effectiveRenewAt, localDate, renewalStatus } from './reminders'
import { DEFAULT_FX } from './fx-defaults'
import { monthlyCost } from './health'

function decimalFraction(value: number): [bigint, bigint] {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  const [whole, fraction = ''] = coefficient!.split('.')
  const scale = fraction.length - Number(exponent)
  const digits = BigInt(whole! + fraction)
  return scale >= 0 ? [digits, 10n ** BigInt(scale)] : [digits * 10n ** BigInt(-scale), 1n]
}

/** Integer input and decimal-rate fractions avoid losing half-cent ties before display. */
function applyRate(amount: number, target: number, source = 1): number | null {
  const [tn, td] = decimalFraction(target), [sn, sd] = decimalFraction(source)
  const [an, ad] = decimalFraction(amount)
  let numerator = an * tn * sd, denominator = ad * td * sn
  let a = numerator, b = denominator
  while (b) { const remainder = a % b; a = b; b = remainder }
  if (a) { numerator /= a; denominator /= a }
  const result = Number(numerator) / Number(denominator)
  return Number.isFinite(result) ? result : null
}

export function convertMinor(amount: number, from: string, to: string, snapshot: FxSnapshot | null = null): number | null {
  return Number.isSafeInteger(amount) ? convertAmount(amount, from, to, snapshot) : null
}

/** Also accepts the unrounded monthly sum when producing its secondary-currency display. */
export function convertAmount(amount: number, from: string, to: string, snapshot: FxSnapshot | null = null): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null
  if (from === to) return amount
  const rates = (snapshot ?? DEFAULT_FX).rates
  const source = from === 'EUR' ? 1 : rates[from], target = to === 'EUR' ? 1 : rates[to]
  if (!Number.isFinite(source) || !Number.isFinite(target) || source! <= 0 || target! <= 0) return null
  return applyRate(amount, target!, source!)
}

export function billingSummary(hosts: HostPublic[], currency: string, snapshot: FxSnapshot | null, now: number) {
  const rows = hosts.map(host => {
    const meta = host.meta
    const incomplete = meta.price !== null && (!meta.currency || !meta.billingCycle)
    const recurring = !incomplete && meta.price !== null && ['monthly', 'quarterly', 'yearly'].includes(meta.billingCycle ?? '')
    const monthly = recurring ? monthlyCost(meta) : null
    const amount = recurring ? convertMinor(meta.price!, meta.currency!, currency, snapshot) : null
    const months = meta.billingCycle === 'quarterly' ? 3 : meta.billingCycle === 'yearly' ? 12 : 1
    const renewAt = effectiveRenewAt(meta, now)
    return { host, monthly, converted: amount === null ? null : amount / months, incomplete,
      renewAt, status: renewalStatus(renewAt, now) }
  })
  const excluded = rows.filter(row => row.monthly !== null && row.converted === null).length
  const total = rows.some(row => row.monthly !== null) ? rows.reduce((sum, row) => sum + (row.converted ?? 0), 0) : null
  return { rows, excluded, monthly: total, yearly: total === null ? null : total * 12 }
}

export { effectiveRenewAt, localDate, renewalStatus }
