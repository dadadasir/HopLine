import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HostDisk, RunbookPreview } from '@shared/types'
import { cleanupRunbook, type CleanupChange } from '../../../core/runbook/cleanup'
import type { StepResult } from '../../../core/runbook/types'
import { cleanupActual, cleanupEmpty, cleanupGroup, cleanupGroups, cleanupIncompleteReason, cleanupReleased, cleanupSelectable, cleanupSelection, cleanupSize, cleanupTotal } from '../logic/cleanup'
import { toneColor, usageTone } from './Gauge'
import { Modal, PrimaryButton, QuietButton, useT } from './ui'

function SizeLabel({ message, size }: { message: string; size: string }) {
  const t = useT(), [before, after] = t(message, { size: '{size}' }).split('{size}')
  return <>{before}<span className="font-mono tabular-nums">{size}</span>{after}</>
}

export function CleanupCheckbox({ checked, mixed = false, label, disabled, onChange }: { checked: boolean; mixed?: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (input.current) input.current.indeterminate = mixed }, [mixed])
  return <input ref={input} type="checkbox" aria-label={label} aria-checked={mixed ? 'mixed' : checked} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="h-3.5 w-3.5 shrink-0" style={{ accentColor: 'var(--accent)' }} />
}

export function CleanupReady({ plan, selected, onSelect, disk, mountSelector, notice }: { plan: RunbookPreview; selected: string[]; onSelect: (ids: string[]) => void; disk?: HostDisk; mountSelector: ReactNode; notice?: ReactNode }) {
  const t = useT(), selectable = cleanupSelectable(plan), empty = plan.steps.filter(step => cleanupEmpty(plan, step.id))
  const total = cleanupTotal(selectable, plan.cleanup), chosen = cleanupTotal(selected, plan.cleanup)
  const estimated = disk && disk.totalBytes > 0 ? Math.max(0, disk.usagePercent - chosen / disk.totalBytes * 100).toFixed(1) : '—'
  return <div data-cleanup-ready className="space-y-6 pt-6">
    <header className="space-y-2">
      <div className="flex items-center justify-between gap-4"><h3 className="text-[28px] font-medium tracking-tight"><SizeLabel message="cleanup.ui.available" size={cleanupSize(total)} /></h3>{mountSelector}</div>
      <p className="text-[12px] text-muted" title={t('cleanup.ui.estimateHelp')}>{t('cleanup.ui.usageEstimate', { mount: disk?.mountpoint ?? '—', before: disk?.usagePercent.toFixed(1) ?? '—', after: estimated })}</p>
      {notice}
    </header>
    <div className="border-y border-line">
      {cleanupGroups.map(group => {
        const steps = plan.steps.filter(step => cleanupGroup(step.id) === group && !cleanupEmpty(plan, step.id)), ids = steps.map(step => step.id).filter(id => selectable.includes(id))
        const count = ids.filter(id => selected.includes(id)).length
        return <details key={group} data-cleanup-group={group} className="group border-b border-line last:border-b-0">
          <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-3 [&::-webkit-details-marker]:hidden">
            <span onClick={event => event.stopPropagation()}><CleanupCheckbox label={t(`cleanup.group.${group}`)} checked={ids.length > 0 && count === ids.length} mixed={count > 0 && count < ids.length} disabled={!ids.length} onChange={checked => onSelect(checked ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.includes(id)))} /></span>
            <span className="w-32 shrink-0 text-[14px] font-medium">{t(`cleanup.group.${group}`)}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={t(`cleanup.ui.group.${group}`)}>{t(`cleanup.ui.group.${group}`)}</span>
            <span className="shrink-0 font-mono text-[13px]">{cleanupSize(cleanupTotal(ids.filter(id => selected.includes(id)), plan.cleanup))}</span>
            <span className="grid h-5 w-5 shrink-0 place-items-center text-muted transition-transform group-open:rotate-90" aria-hidden>›</span>
          </summary>
          <div className="pb-3 pl-7">
            {!steps.length && <p className="py-2 text-[12px] text-muted">{t('cleanup.ui.emptyCategory')}</p>}
            {steps.map(step => <CleanupItem key={step.id} step={step} plan={plan} selected={selected} selectable={selectable} onSelect={onSelect} />)}
          </div>
        </details>
      })}
    </div>
    {empty.length > 0 && <details data-cleanup-empty className="text-[12px] text-muted"><summary className="cursor-pointer">{t('cleanup.ui.emptyCount', { count: empty.length })}</summary><ul className="mt-3 space-y-2 pl-4">{empty.map(step => <li key={step.id} data-cleanup-empty-item={step.id}>{t(`cleanup.ui.name.${step.id}`)}</li>)}</ul></details>}
    <p className="text-[11px] text-muted">{t('cleanup.ui.scope')}</p>
  </div>
}

function CleanupItem({ step, plan, selected, selectable, onSelect }: { step: RunbookPreview['steps'][number]; plan: RunbookPreview; selected: string[]; selectable: string[]; onSelect: (ids: string[]) => void }) {
  const t = useT(), [tip, setTip] = useState(false), [commandOpen, setCommandOpen] = useState(false), definition = cleanupRunbook.steps.find(item => item.id === step.id)!, estimate = plan.cleanup?.[step.id]
  return <div data-cleanup-item={step.id} className="border-t border-line/60 text-[12px]">
    <div className="flex min-h-10 items-center gap-3">
      <CleanupCheckbox label={t(`cleanup.ui.name.${step.id}`)} checked={selected.includes(step.id)} disabled={!selectable.includes(step.id)} onChange={checked => onSelect(checked ? [...selected, step.id] : selected.filter(id => id !== step.id))} />
      <span className="min-w-0 flex-1 truncate" title={t(`cleanup.ui.effect.${step.id}`)}>{t(`cleanup.ui.name.${step.id}`)}{definition.dangerous && <button className="ml-2 inline-grid h-4 w-4 place-items-center rounded-full border text-[10px]" style={{ color: toneColor.warn }} aria-label={t('cleanup.ui.attention')} aria-expanded={tip} onClick={() => setTip(!tip)} title={t(`cleanup.ui.effect.${step.id}`)}>!</button>}</span>
      <span className="shrink-0 font-mono text-muted">{selectable.includes(step.id) ? cleanupSize(estimate!.bytes!) : t('cleanup.ui.unknown')}</span>
      <button className="shrink-0 text-[11px] text-muted hover:text-ink" aria-expanded={commandOpen} onClick={() => setCommandOpen(!commandOpen)}>{t('cleanup.ui.command')}</button>
    </div>
    {tip && <p className="pb-2 pl-6 text-muted">{t(`cleanup.ui.effect.${step.id}`)}</p>}
    <details open={commandOpen} className="text-muted"><summary className="hidden">{t('cleanup.ui.command')}</summary><pre className="mb-3 overflow-x-auto whitespace-pre-wrap break-all rounded border border-line p-3 text-[11px]">{step.command}</pre>{step.id === 'docker-container-logs' && estimate?.logDrivers && <div data-cleanup-log-drivers className="mb-3 space-y-1">{(['jsonFile', 'local', 'journald', 'other'] as const).filter(driver => estimate.logDrivers![driver] > 0).map(driver => <p key={driver}>{t(`cleanup.driver.${driver}`, { count: estimate.logDrivers![driver] })}</p>)}</div>}</details>
  </div>
}

export function CleanupReadyFooter({ plan, selected, onSelect, onConfirm }: { plan: RunbookPreview; selected: string[]; onSelect: (ids: string[]) => void; onConfirm: () => void }) {
  const t = useT()
  return <div data-cleanup-footer className="flex items-center justify-between gap-3">
    <div className="space-y-1"><p className="text-[13px]">{t('cleanup.selectedCount', { count: selected.length })}</p><div className="flex items-center gap-2 text-[12px] text-muted">{(['all', 'none', 'recommended'] as const).map((action, index) => <span key={action} className="flex items-center gap-2">{index > 0 && <span aria-hidden>·</span>}<button data-cleanup-select={action} className="hover:text-ink" onClick={() => onSelect(action === 'all' ? cleanupSelectable(plan) : action === 'none' ? [] : cleanupSelection(plan).filter(id => cleanupSelectable(plan).includes(id)))}>{t(`cleanup.ui.${action}`)}</button></span>)}</div></div>
    <PrimaryButton disabled={!selected.length} onClick={onConfirm}><SizeLabel message="cleanup.ui.cleanSize" size={cleanupSize(cleanupTotal(selected, plan.cleanup))} /></PrimaryButton>
  </div>
}

export function CleanupConfirmation({ plan, selected, onClose, onRun }: { plan: RunbookPreview; selected: string[]; onClose: () => void; onRun: () => void }) {
  const t = useT(), risks = cleanupRunbook.steps.filter(step => step.dangerous && selected.includes(step.id))
  return <Modal open title={t('cleanup.ui.confirmTitle')} onClose={onClose} width="w-[460px] overflow-hidden" footer={<div className="flex justify-end gap-2"><QuietButton onClick={onClose}>{t('cleanup.ui.cancel')}</QuietButton><PrimaryButton onClick={onRun}>{t('cleanup.ui.confirm')}</PrimaryButton></div>}>
    <div data-cleanup-confirm className="space-y-4 text-[13px]"><p>{t('cleanup.ui.confirmBody', { size: cleanupSize(cleanupTotal(selected, plan.cleanup)) })}</p>{risks.length > 0 && <ul className="space-y-3 border-t border-line pt-4">{risks.map(step => <li key={step.id}><span className="font-medium">{t(`cleanup.ui.name.${step.id}`)}</span><p className="mt-1 text-[12px] text-muted">{t(`cleanup.ui.effect.${step.id}`)}</p></li>)}</ul>}</div>
  </Modal>
}

export type CleanupComparison = { mount: string; before: HostDisk | null; after: HostDisk | null }
export function CleanupResults({ selected, results, changes, comparison }: { selected: string[]; results: Record<string, StepResult>; changes: Record<string, CleanupChange>; comparison?: CleanupComparison }) {
  const t = useT(), measured = Object.fromEntries(selected.filter(id => changes[id]).map(id => [id, changes[id]]))
  const completed = selected.filter(id => ['executed', 'already'].includes(results[id]?.status)), incomplete = selected.filter(id => !completed.includes(id))
  const releasedRows = selected.filter(id => completed.includes(id) || (cleanupActual(changes[id]) ?? 0) > 0)
  const known = Object.values(measured).some(change => cleanupActual(change) !== null), missing = completed.some(id => cleanupActual(changes[id]) === null)
  return <div data-cleanup-results className="space-y-7 pt-6">
    <header><p className="mb-2 text-[12px] text-muted">{t('cleanup.ui.finished')}</p><h3 className="text-[32px] font-medium tracking-tight">{known ? <SizeLabel message="cleanup.ui.released" size={cleanupSize(cleanupReleased(measured))} /> : t('cleanup.ui.releaseUnknown')}</h3>{missing && <p className="mt-2 text-[12px] text-muted">{t('cleanup.ui.measuredOnly')}</p>}</header>
    <div data-cleanup-comparison className="space-y-3">
      <div className="flex justify-between text-[12px]"><span className="font-mono">{comparison?.mount ?? '—'}</span><span className="text-muted">{t('cleanup.ui.usage')}</span></div>
      <div className="relative h-2 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}><div className="absolute inset-y-0 left-0 rounded-full opacity-30" style={{ width: `${comparison?.before?.usagePercent ?? 0}%`, background: toneColor[usageTone(comparison?.before?.usagePercent)] }} /><div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${comparison?.after?.usagePercent ?? 0}%`, background: toneColor[usageTone(comparison?.after?.usagePercent)] }} /></div>
      <div className="flex justify-between text-[12px] text-muted">{(['before', 'after'] as const).map(side => <span key={side}>{t(`cleanup.${side}`)} <span className="ml-2 font-mono text-ink">{comparison?.[side] ? `${comparison[side]!.usagePercent.toFixed(1)}%` : '—'}</span></span>)}</div>
      <p className="text-[11px] text-muted">{t('cleanup.ui.comparisonNote')}</p>
    </div>
    {releasedRows.length > 0 && <ul className="divide-y divide-line border-y border-line">{releasedRows.map(id => <li key={id} data-cleanup-completed={id} className="flex items-center justify-between gap-4 py-3 text-[13px]"><span>{t(`cleanup.ui.name.${id}`)}</span><span className="font-mono text-muted">{cleanupActual(changes[id]) === null ? t('cleanup.ui.unmeasured') : cleanupSize(cleanupActual(changes[id])!)}</span></li>)}</ul>}
    {incomplete.length > 0 && <section data-cleanup-incomplete className="space-y-2"><h4 className="text-[13px] font-medium" style={{ color: toneColor.warn }}>{t('cleanup.ui.incomplete', { count: incomplete.length })}</h4><ul className="divide-y divide-line">{incomplete.map(id => <li key={id} className="flex items-baseline justify-between gap-4 py-3 text-[12px]"><span className="shrink-0">{t(`cleanup.ui.name.${id}`)}</span><span className="text-right text-muted">{t(cleanupIncompleteReason(results[id]))}</span></li>)}</ul></section>}
  </div>
}
