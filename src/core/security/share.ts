import { localDate } from '../reminders'
import type { SecurityReport } from './types'

/** Rules grouped into the areas shown on the card. Only the area and its tally are shared, never the evidence. */
export const shareAreas: Record<string, string[]> = {
  ssh: ['ssh-root-login', 'ssh-password-auth', 'ssh-empty-passwords', 'no-bruteforce-guard'],
  network: ['firewall-off', 'db-exposed', 'docker-api-exposed'],
  accounts: ['uid0-accounts', 'empty-password-accounts'],
  updates: ['os-eol', 'auto-updates-off', 'security-updates-pending', 'reboot-required'],
  processes: ['miner-process'],
  tls: ['tls-expiring']
}
export interface ShareCheck { key: string; failed: number; unknown: number; ignored?: number; total: number }
export interface ShareData { score: number; counts: number[]; date: string; checks?: ShareCheck[]; host?: string }

/**
 * Show a partial address only after the user opts in. Masking is not anonymity:
 * IPv4 keeps two octets, IPv6 two groups, and hostnames a prefix and suffix.
 */
export function maskHost(host: string): string {
  const value = host.trim(), v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})$/.exec(value)
  if (v4) return `${v4[1]}.***.***.${v4[2]}`
  if (value.includes(':')) { const parts = value.split(':').filter(Boolean); return parts.length > 1 ? `${parts[0]}:***:${parts[parts.length - 1]}` : '***' }
  const labels = value.split('.')
  return labels.length > 1 ? `${value.slice(0, 2)}***.${labels[labels.length - 1]}` : `${value.slice(0, 2)}***`
}

export function shareData(report: SecurityReport, host?: string): ShareData {
  const scored = report.results.filter((r) => r.id !== 'ssh-default-port')
  const checks = Object.entries(shareAreas).map(([key, ids]) => {
    const rows = scored.filter((r) => ids.includes(r.id))
    return { key, failed: rows.filter((r) => r.status === 'fail').length, unknown: rows.filter((r) => r.status === 'unknown').length, ignored: rows.filter((r) => r.status === 'ignored').length, total: rows.length }
  }).filter((check) => check.total > 0)
  return {
    score: report.score, counts: (['high', 'medium', 'low'] as const).map((level) => scored.filter((r) => r.status === 'fail' && r.severity === level).length),
    date: localDate(report.snapshot.collectedAt), checks, ...(host ? { host: maskHost(host) } : {})
  }
}

export function shareHTML(data: ShareData, t: (key: string) => string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), number = (n: number) => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  const score = Math.min(100, number(data.score)), color = score >= 80 ? '#5ed3a2' : score >= 60 ? '#f2b862' : '#ff8f82'
  const radius = 44, length = 2 * Math.PI * radius
  const checks = (data.checks ?? []).slice(0, 6).map((check) => {
    const failed = number(check.failed), unknown = number(check.unknown), ignored = number(check.ignored ?? 0), total = number(check.total)
    const state = failed ? 'bad' : unknown || ignored || !total ? 'unknown' : 'ok'
    const text = failed ? `${failed}/${total}` : escape(t(unknown || !total ? 'security.shareUnknown' : ignored ? ignored === total ? 'security.ignored' : 'security.sharePartialIgnored' : 'security.sharePassed'))
    return `<li class="${state}"><i></i><span>${escape(t(`security.area.${/^[a-z]+$/.test(check.key) ? check.key : 'ssh'}`))}</span><em>${text}</em></li>`
  }).join('')
  const host = data.host && /^[\w.:*-]{1,80}$/.test(data.host) ? data.host : ''
  return `<!doctype html><html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:#111211;color:#ecece9;font-family:system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
main{box-sizing:border-box;height:100%;padding:4.2vw 5vw;display:flex;flex-direction:column;background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1px);background-size:2vw 2vw}
.mono{font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
.top{display:flex;align-items:center;justify-content:space-between;font-size:1.7vw;color:#9a9a94}
.top b{color:#ecece9;font-weight:500}.top .p{color:#a9a8ff}
.body{flex:1;display:flex;align-items:center;gap:5vw;min-height:0}
.score{position:relative;width:27vw;height:27vw;flex:none}.score svg{width:100%;height:100%;transform:rotate(-90deg)}
.score div{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
strong{font-size:10.5vw;line-height:1;font-weight:500;letter-spacing:-.04em;color:${color};font-variant-numeric:tabular-nums}
.score small{margin-top:.8vw;font-size:1.5vw;color:#9a9a94}
.side{flex:1;min-width:0}
.counts{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2vw}
.count{border:1px solid #33332f;border-radius:1vw;padding:1.5vw 1.6vw;background:rgba(29,29,28,.9)}
.count span{display:block;font-size:1.5vw;color:#9a9a94}.count b{display:block;margin-top:.7vw;font-size:3.6vw;font-weight:500;line-height:1}
.count:nth-child(1) b{color:#ff8f82}.count:nth-child(2) b{color:#f2b862}
ul{list-style:none;margin:2vw 0 0;padding:0;display:grid;grid-template-columns:repeat(2,1fr);gap:1.1vw 3vw;font-size:1.65vw}
li{display:flex;align-items:center;gap:1vw;border-bottom:1px solid #2a2a27;padding-bottom:.9vw}
li i{width:.9vw;height:.9vw;border-radius:50%;background:#5ed3a2;flex:none}li span{flex:1}li em{font-style:normal;color:#5ed3a2}
li.bad i{background:#ff8f82}li.bad em{color:#ff8f82}li.unknown i{background:#6d6d68}li.unknown em{color:#9a9a94}
footer{display:flex;align-items:flex-end;justify-content:space-between;color:#9a9a94;font-size:1.5vw}
.brand{font-size:2.4vw;font-weight:600;letter-spacing:-.03em;color:#ecece9}.brand u{text-decoration:none;color:#a9a8ff}.by{margin-top:.4vw}
</style><main><div class="top mono"><span><span class="p">HopLine</span> / ${escape(t('security.title'))}${host ? ` <b>${escape(host)}</b>` : ''}</span><time>${escape(/^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : '')}</time></div>
<div class="body"><div class="score"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${radius}" fill="none" stroke="#2a2a27" stroke-width="5"/><circle cx="50" cy="50" r="${radius}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(score / 100 * length).toFixed(1)} ${length.toFixed(1)}"/></svg><div><strong>${score}</strong><small>${escape(t('security.shareScore'))}</small></div></div>
<div class="side"><div class="counts">${['high', 'medium', 'low'].map((s, i) => `<div class="count"><span>${escape(t(`security.${s}`))}</span><b>${number(data.counts[i])}</b></div>`).join('')}</div>${checks ? `<ul class="mono">${checks}</ul>` : ''}</div></div>
<footer><div><div class="brand">Hop<u>Line</u></div><div class="by">${escape(t('security.by'))}</div></div><span class="mono">${escape(t('security.shareMethod'))}</span></footer></main></html>`
}
