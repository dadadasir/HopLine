export const FX_INTERVAL_MS = 86_400_000

export interface FxSnapshot {
  date: string
  base: 'EUR'
  rates: Record<string, number>
  source: 'ecb'
  fetchedAt: number
}
