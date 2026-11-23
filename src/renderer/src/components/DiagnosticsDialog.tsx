import { useEffect, useState } from 'react'
import { api, errorText, patch, useAppSelector } from '../state'
import { Modal, PrimaryButton, QuietButton, useT } from './ui'

export function DiagnosticsDialog() {
  const open = useAppSelector((state) => state.diagnosticsOpen)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const t = useT()
  useEffect(() => {
    if (!open) return
    let canceled = false
    setText(null); setError('')
    void api().diagnostics.preview().then((value) => { if (!canceled) setText(value) })
      .catch((error) => { if (!canceled) setError(errorText(error)) })
    return () => { canceled = true }
  }, [open])
  const close = () => { if (!saving) patch({ diagnosticsOpen: false }) }
  const save = async () => {
    setSaving(true); setError('')
    try { if (text !== null && await api().diagnostics.save(text)) patch({ diagnosticsOpen: false }) }
    catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  return <Modal open={!!open} title={t('diagnostics.title')} onClose={close} width="w-[760px]">
    <p className="mb-3 text-[13px] text-muted">{t('diagnostics.review')}</p>
    <textarea readOnly aria-label={t('diagnostics.title')} value={text ?? ''} className="h-[50vh] w-full resize-none p-3 font-mono text-[12px]" />
    {error && <p role="alert" className="text-[13px] text-red-600">{error}</p>}
    <div className="mt-4 flex justify-end gap-2">
      <QuietButton onClick={close}>{t('host.cancel')}</QuietButton>
      <PrimaryButton disabled={text === null || saving} onClick={() => void save()}>{t('host.save')}</PrimaryButton>
    </div>
  </Modal>
}
