import { billingSummary, convertAmount, effectiveRenewAt } from '../../../core/billing'
import { CURRENCIES, displayCurrency, secondaryCurrency } from '../../../core/currency'
import { money } from '../logic/overview'
import { useState } from 'react'
import type { HostPublic } from '@shared/types'
import { api, errorText, getState, shallowEqual, useAppSelector } from '../state'
import { assetInput, dateInput } from '../logic/overview'
import { Field, Modal, PrimaryButton, TextInput, useT } from './ui'

export function AssetDialog({ host, onClose }: { host: HostPublic; onClose: () => void }) {
  const t = useT()
  return <Modal open title={`${t('overview.edit')} · ${host.name}`} onClose={onClose}><AssetForm host={host} onSaved={onClose} /></Modal>
}

export function AssetForm({ host, onSaved }: { host: HostPublic; onSaved: () => void }) {
  const t = useT()
  const [fields, setFields] = useState<Record<string, string>>({
    provider: host.meta.provider ?? '',
    price: host.meta.price === null ? '' : String(host.meta.price / 100), currency: host.meta.currency ?? '',
    billingCycle: host.meta.billingCycle ?? '', renewAt: dateInput(effectiveRenewAt(host.meta, Date.now())), tags: host.meta.tags.join(', ')
  })
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const note = noteDraft ?? host.meta.note ?? ''
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const state = useAppSelector(s => ({ settings: s.settings, fx: s.fx }), shallowEqual)
  const locale = state.settings?.language ?? 'zh', zh = locale === 'zh'
  const target = displayCurrency(state.settings?.displayCurrency, locale)
  const preview = (() => {
    try { return billingSummary([assetInput(host, { ...fields, note }) as HostPublic], target, state.fx, Date.now()).rows[0] }
    catch { return null }
  })()
  const other = secondaryCurrency(target)
  const primaryMonthly = preview?.converted ?? preview?.monthly ?? null
  const primaryCode = preview?.converted != null ? target : preview?.host.meta.currency ?? target
  const secondaryMonthly = primaryCode === target && primaryMonthly !== null ? convertAmount(primaryMonthly, target, other, state.fx) : null
  const change = (key: string, value: string) => setFields({ ...fields, [key]: value })
  return <form className="grid grid-cols-2 gap-3" noValidate onSubmit={(event) => {
      event.preventDefault()
      if (saving) return
      setSaving(true)
      setError('')
      void (async () => {
        try {
          const current = getState().hosts.find((item) => item.id === host.id)
          if (!current) throw new Error(t('overview.missing'))
          await api().hosts.save(assetInput(current, { ...fields, note: noteDraft ?? current.meta.note ?? '' }))
          setNoteDraft(null)
          onSaved()
        } catch (failure) {
          setError(errorText(failure))
        } finally { setSaving(false) }
      })()
    }}>
      {['provider', 'price', 'currency', 'renewAt', 'tags'].map((key) => <Field key={key} label={t(`overview.${key}`)}>
        <TextInput data-asset-field={key} value={fields[key]} type="text" placeholder={key === 'renewAt' ? 'YYYY-MM-DD' : undefined} inputMode={key === 'price' ? 'decimal' : undefined} list={key === 'currency' ? `asset-currencies-${host.id}` : undefined} onChange={(event) => change(key, event.target.value)} />
      </Field>)}
      <datalist id={`asset-currencies-${host.id}`}>{CURRENCIES.map((currency) => <option key={currency} value={currency} />)}</datalist>
      <Field label={t('overview.billingCycle')}>
        <select data-asset-cycle className="h-9 w-full px-2" value={fields.billingCycle} onChange={(event) => change('billingCycle', event.target.value)}>
          {['', 'monthly', 'quarterly', 'yearly', 'once'].map((cycle) => <option key={cycle} value={cycle}>{cycle ? t(`overview.${cycle}`) : '—'}</option>)}
        </select>
      </Field>
      <div className="col-span-2 rounded-lg border border-line bg-canvas p-3 text-[12px]" data-asset-monthly>
        <p>{zh ? '月费 ' : 'Monthly '}{primaryMonthly === null ? '—' : money(primaryMonthly, primaryCode, locale)}{secondaryMonthly === null ? '' : zh ? `（${money(secondaryMonthly, other, locale)}）` : ` (${money(secondaryMonthly, other, locale)})`}</p>
      </div>
      <div className="col-span-2">
        <Field label={t('overview.note')}>
          <textarea className="min-h-24 w-full p-2" value={note} onChange={(event) => setNoteDraft(event.target.value)} />
        </Field>
      </div>
      {error && <p role="alert" className="col-span-2 text-[12px] text-red-600 dark:text-red-300">{error}</p>}
      <div className="col-span-2 flex justify-end"><PrimaryButton type="submit" disabled={saving}>{t('host.save')}</PrimaryButton></div>
    </form>
}
