import type { ReactNode } from 'react'

export type Tone = 'ok' | 'warn' | 'bad' | 'none'

/** Usage thresholds match the health score: above 80% is a warning, above 90% is a risk. */
export function usageTone(value: number | null | undefined): Tone {
  return value == null ? 'none' : value > 90 ? 'bad' : value > 80 ? 'warn' : 'ok'
}
/** Scores read the other way round: 80 and above is healthy, below 60 is a risk. */
export function scoreTone(value: number | null | undefined): Tone {
  return value == null ? 'none' : value >= 80 ? 'ok' : value >= 60 ? 'warn' : 'bad'
}
export const toneColor: Record<Tone, string> = { ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', bad: 'var(--risk-fg)', none: 'var(--muted)' }

/** A ring that fills clockwise from the top. `value` is 0–100; null draws an empty track. */
export function Ring({ value, tone, size = 96, stroke = 8, children, label }: { value: number | null; tone: Tone; size?: number; stroke?: number; children?: ReactNode; label?: string }) {
  const radius = (size - stroke) / 2, length = 2 * Math.PI * radius
  const filled = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100 * length
  return <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={label}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--track)" strokeWidth={stroke} strokeDasharray={value === null ? '2 5' : undefined} />
      {value !== null && <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={toneColor[tone]} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${filled} ${length}`} className="gauge-arc" />}
    </svg>
    <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
  </div>
}

/** A thin horizontal usage bar. */
export function Meter({ value, tone, className = 'h-1.5' }: { value: number | null; tone: Tone; className?: string }) {
  return <div className={`overflow-hidden rounded-full ${className}`} style={{ background: 'var(--track)' }}>
    <div className="gauge-bar h-full rounded-full" style={{ width: `${value === null || value <= 0 ? 0 : Math.max(2, Math.min(100, value))}%`, background: toneColor[tone] }} />
  </div>
}

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${pulse ? 'animate-pulse' : ''}`} style={{ background: toneColor[tone], boxShadow: tone === 'none' ? undefined : `0 0 0 3px color-mix(in srgb, ${toneColor[tone]} 18%, transparent)` }} />
}

/** Small monospace key/value chip used for facts such as uptime and load. */
export function Chip({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return <span title={title} className="inline-flex items-baseline gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] leading-none"><span className="text-muted">{label}</span><span>{children}</span></span>
}
