import { PasswordInput } from './PasswordInput'
import { runbookError } from '../logic/runbook'
import { useEffect, useState } from 'react'
import type { RunbookPreview, RunbookProgress } from '@shared/types'
import type { Params, Runbook, RunbookSummary, StepResult } from '../../../core/runbook/types'
import { api, patch, useAppSelector } from '../state'
import { Field, Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'

export function RunbookDialogs() {
  const target = useAppSelector((state) => state.runbookTarget), hosts = useAppSelector((state) => state.hosts), t = useT()
  if (!target) return null
  const close = () => patch({ runbookTarget: null })
  if (!target.hostId) return <Modal open title={t('runbook.chooseHost')} onClose={close}>
    {hosts.map((host) => <button key={host.id} className="block w-full rounded p-3 text-left hover:bg-accent-soft" onClick={() => patch({ runbookTarget: { ...target, hostId: host.id } })}>{host.name} · {host.username}@{host.host}</button>)}
    {!hosts.length && <p>{t('sidebar.empty')}</p>}
  </Modal>
  return <RunbookDialog key={`${target.hostId}:${target.book.id}`} {...target} onClose={close} />
}

export function RunbookDialog({ book, hostId, onClose }: { book: Runbook; hostId: string; onClose: () => void }) {
  const t = useT(), host = useAppSelector((state) => state.hosts.find((item) => item.id === hostId))
  const [params, setParams] = useState<Params>({}), [plan, setPlan] = useState<RunbookPreview>(), [selected, setSelected] = useState<string[]>([])
  const [password, setPassword] = useState(''), [busy, setBusy] = useState<'plan' | 'run' | false>(false), [consumed, setConsumed] = useState(false)
  const [results, setResults] = useState<Record<string, StepResult>>({}), [summary, setSummary] = useState<RunbookSummary>(), [error, setError] = useState('')
  useEffect(() => api().on('runbook:progress', (event: RunbookProgress) => {
    if (event.hostId === hostId && event.planId === plan?.id) setResults((current) => ({ ...current, [event.result.stepId]: event.result }))
  }), [hostId, plan?.id])
  const check = async () => {
    setBusy('plan'); setError(''); setPlan(undefined); setResults({}); setSummary(undefined); setSelected([]); setPassword(''); setConsumed(false)
    try { setPlan(await api().runbook.plan(hostId, book.id, params)) }
    catch (err) { setError(runbookError(err)) } finally { setBusy(false) }
  }
  const run = async () => {
    if (!plan || consumed) return
    setBusy('run'); setConsumed(true); setError(''); setPassword('')
    try { setSummary(await api().runbook.run(hostId, plan.id, selected, password || undefined)) }
    catch (err) { setError(runbookError(err)) } finally { setBusy(false) }
  }
  const runnable = plan ? selected.filter((id) => plan.steps.some((step) => step.id === id && step.status === 'needed')).length : 0
  return <Modal open title={`${t(book.title)} · ${host?.name ?? t('overview.missing')}`} onClose={() => { if (!busy) onClose() }} width="w-[720px]">
    <div className="max-h-[70vh] space-y-4 overflow-auto">
      {(book.params ?? []).map((param) => <Field key={param.name} label={t(param.label)}>{param.secret ? <PasswordInput secretLabel={t(param.label)} disabled={!!busy} value={params[param.name] ?? ''} onChange={(event) => { setParams({ ...params, [param.name]: event.target.value }); setPlan(undefined); setResults({}); setSummary(undefined); setPassword('') }} /> : <TextInput disabled={!!busy} value={params[param.name] ?? ''} onChange={(event) => { setParams({ ...params, [param.name]: event.target.value }); setPlan(undefined); setResults({}); setSummary(undefined); setPassword('') }} />}</Field>)}
      <PrimaryButton disabled={!!busy || !host} onClick={() => void check()}>{t(busy === 'plan' ? 'runbook.checking' : 'runbook.check')}</PrimaryButton>
      {plan && <RunbookSteps {...{ book, plan, results, selected, setSelected }} disabled={!!busy || consumed} />}
      {plan?.sudo === 'password' && !consumed && <Field label={t('runbook.password')}><PasswordInput secretLabel={t('runbook.password')} autoComplete="off" disabled={!!busy} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>}
      {plan && <PrimaryButton disabled={!!busy || consumed || !runnable || !host} onClick={() => void run()}>{t('runbook.run', { count: runnable })}</PrimaryButton>}
      {busy === 'run' && <QuietButton onClick={() => { void api().runbook.cancel(hostId).catch((err) => setError(runbookError(err))) }}>{t('runbook.cancel')}</QuietButton>}
      {summary && <RunbookSummaryView summary={summary} />}
      {error && <p role="alert" className="text-red-600 dark:text-red-300">{t(error)}</p>}
    </div>
  </Modal>
}

export function RunbookSteps({ book, plan, results, selected, setSelected, disabled }: {
  book: Runbook; plan: RunbookPreview; results: Record<string, StepResult>; selected: string[]
  setSelected: (selected: string[]) => void; disabled: boolean
}) {
  const t = useT()
  return <>{plan.steps.map((step) => {
        const definition = book.steps.find((item) => item.id === step.id)!, result = results[step.id]
        return <section key={step.id} style={definition.dangerous ? { borderColor: 'color-mix(in srgb, var(--risk-fg) 45%, var(--line))', color: 'var(--risk-fg)' } : undefined} className="space-y-2 rounded border border-line p-3">
          <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled || step.status !== 'needed'} checked={selected.includes(step.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, step.id] : selected.filter((id) => id !== step.id))} />
            <strong>{t(definition.title)}</strong><span className="rounded bg-accent-soft px-2 text-[12px]">{t(`runbook.${result?.status ?? step.status}`)}</span></label>
          {definition.description && <p>{t(definition.description)}</p>}
          {(() => {
            // The default reason repeats the status badge; only show reasons that add information.
            const reason = (result?.reason ?? step.reason).split('；').map((part) => t(part)).join(' · ')
            return reason !== t(`runbook.${result?.status ?? step.status}`) && <p className="text-[12px]">{reason}</p>
          })()}
          <details><summary>{t('runbook.command')}</summary><pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-[12px]">{step.command}</pre></details>
          {result?.output && <details><summary>{t('runbook.output')}</summary><pre className="whitespace-pre-wrap break-all font-mono text-[12px]">{result.output}</pre></details>}
        </section>
      })}</>
}
export function RunbookSummaryView({ summary }: { summary: RunbookSummary }) {
  const t = useT()
  return <p role="status">{t('runbook.summary', summary)}</p>
}
