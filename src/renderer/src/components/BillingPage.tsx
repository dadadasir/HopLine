import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { billingSummary, localDate } from '../../../core/billing'
import { REMINDER_WINDOW_DAYS } from '../../../core/reminders'
import { displayCurrency } from '../../../core/currency'
import { money } from '../logic/overview'
import { navigate, shallowEqual, useAppSelector, openHost } from '../state'
import { QuietButton } from './ui'

export function BillingPage() {
  const state = useAppSelector(s => ({ hosts: s.hosts, settings: s.settings, fx: s.fx }), shallowEqual)
  const [sort, setSort] = useState<'renewal' | 'amount'>('renewal')
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const locale = state.settings?.language ?? 'zh', zh = locale === 'zh'
  const target = displayCurrency(state.settings?.displayCurrency, locale)
  const summary = billingSummary(state.hosts, target, state.fx, now)
  const rows = [...summary.rows].sort((a, b) => sort === 'renewal'
    ? (a.renewAt ?? Infinity) - (b.renewAt ?? Infinity) || a.host.name.localeCompare(b.host.name)
    : (a.converted === null ? b.converted === null ? 0 : 1 : b.converted === null ? -1 : b.converted - a.converted) || a.host.name.localeCompare(b.host.name))
  const cycle = { monthly: zh ? '月付' : 'Monthly', quarterly: zh ? '季付' : 'Quarterly', yearly: zh ? '年付' : 'Yearly', once: zh ? '一次性' : 'One-time' }
  const monthly = summary.monthly === null ? '—' : money(summary.monthly, target, locale)
  const yearly = summary.yearly === null ? '—' : money(summary.yearly, target, locale)
  return <section className="min-w-0 flex-1 overflow-auto p-6" aria-label={zh ? '计费总览' : 'Billing overview'}>
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">{zh ? '计费总览' : 'Billing overview'}</h1><QuietButton onClick={() => navigate({ page: 'overview' })}><ArrowLeft className="h-4 w-4" />{zh ? '返回总览' : 'Back to overview'}</QuietButton></div><select aria-label={zh ? '计费排序' : 'Sort billing'} className="h-9 px-2 text-[12px]" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="renewal">{zh ? '按续费日期' : 'Renewal date'}</option><option value="amount">{zh ? '按月费（从高到低）' : 'Monthly amount (highest first)'}</option></select></header>
    <div className="overflow-x-auto rounded-xl border border-line bg-panel"><table className="w-full min-w-[720px] text-left text-[12px]" data-billing-table>
      <thead className="border-b border-line text-muted"><tr>{[zh ? '主机' : 'Host', zh ? '厂商' : 'Provider', zh ? '价格 / 周期' : 'Price / cycle', zh ? `月费（${target}）` : `Monthly (${target})`, zh ? '下次续费' : 'Next renewal', zh ? '状态' : 'Status'].map(label => <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-line">{rows.map(row => <tr key={row.host.id} data-billing-host={row.host.id}>
        <td className="min-w-32 max-w-44 px-3 py-3"><button className="block max-w-full truncate text-left font-medium text-accent" onClick={() => openHost(row.host.id, 'assets')}>{row.host.name}</button></td>
        <td className="min-w-28 max-w-32 break-words px-3 py-3">{row.host.meta.provider || '—'}</td>
        <td className="whitespace-nowrap px-3 py-3">{row.host.meta.price !== null && row.host.meta.currency ? money(row.host.meta.price, row.host.meta.currency, locale) : '—'}{row.host.meta.billingCycle && ` / ${cycle[row.host.meta.billingCycle]}`}</td>
        <td className="whitespace-nowrap px-3 py-3 font-mono">{row.incomplete ? <button className="font-sans text-accent underline" onClick={() => openHost(row.host.id, 'assets')}>{zh ? '信息不完整' : 'Incomplete details'}</button> : row.converted !== null ? money(row.converted, target, locale) : row.monthly !== null ? money(row.monthly, row.host.meta.currency!, locale) : '—'}</td>
        <td className="whitespace-nowrap px-3 py-3">{row.renewAt === null ? '—' : localDate(row.renewAt)}</td>
        <td className={`whitespace-nowrap px-3 py-3 ${row.status === 'overdue' ? 'text-red-600 dark:text-red-300' : row.status === 'soon' ? 'text-amber-700 dark:text-amber-300' : 'text-muted'}`}>{row.renewAt !== null && localDate(row.renewAt) === localDate(now) ? zh ? '今天续费' : 'Renews today' : row.status === 'overdue' ? zh ? '已逾期' : 'Overdue' : row.status === 'soon' ? zh ? `${REMINDER_WINDOW_DAYS} 天内` : `Within ${REMINDER_WINDOW_DAYS} days` : zh ? '正常' : 'Normal'}</td>
      </tr>)}</tbody>
    </table>{!rows.length && <p className="p-8 text-center text-sm text-muted">{zh ? '尚无周期费用' : 'No recurring costs'}</p>}</div>
    <div className="mt-5 space-y-2" data-billing-summary><div className="flex flex-wrap gap-x-8 gap-y-2 text-sm"><p>{zh ? `每月合计约 ${monthly}` : `About ${monthly} per month`}</p><p>{zh ? `每年合计约 ${yearly}` : `About ${yearly} per year`}</p></div>{summary.excluded > 0 && <p className="text-[12px] text-muted" data-billing-excluded>{zh ? `不含 ${summary.excluded} 项` : `Excludes ${summary.excluded} ${summary.excluded === 1 ? 'item' : 'items'}`}</p>}</div>
  </section>
}
