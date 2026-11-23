import { useEffect, useState } from 'react'
import { api, patch, shallowEqual, useAppSelector } from '../state'
import { checkForUpdates } from '../state/updates'
import { Chip } from './Gauge'
import { Modal, PrimaryButton, QuietButton, useT } from './ui'

export function UpdateDialog() {
  const { open, checking, result, version } = useAppSelector(s => ({ open: s.updateOpen, checking: s.updateChecking, result: s.updateResult, version: s.info?.version }), shallowEqual)
  const [openFailed, setOpenFailed] = useState(false)
  const t = useT()
  useEffect(() => setOpenFailed(false), [open, result])
  if (!open) return null
  return <Modal open title={t('updates.title')} onClose={() => patch({ updateOpen: false })} width="w-[600px]">
    <div className="space-y-4 text-[13px]" data-testid="update-dialog">
      <p className="text-muted">{t('updates.installed')} <span className="font-mono">{version}</span></p>
      {checking ? <p role="status">{t('updates.checking')}</p> : result?.status === 'available' ? <>
        <div className="flex flex-wrap items-center gap-2"><Chip label={t('updates.available')}>{result.release.version}</Chip></div>
        <p className="eyebrow">{t('updates.notes')}</p>
        <div className="scroll-thin max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 leading-6" data-testid="update-summary">{result.release.summary || t('updates.noNotes')}</div>
        <p className="text-muted">{t('updates.downloadHint')}</p>
        <PrimaryButton onClick={() => { setOpenFailed(false); void api().updates.openRelease(result.release.url).catch(() => setOpenFailed(true)) }}>{t('updates.openRelease')}</PrimaryButton>
      </> : result?.status === 'current' ? <p role="status">{t('updates.current')}</p> : result?.status === 'error' ? <p role="alert" style={{ color: 'var(--warn-fg)' }}>{t(`updates.error.${result.reason}`)}</p> : null}
      {openFailed && <p role="alert" style={{ color: 'var(--warn-fg)' }}>{t('updates.openFailed')}</p>}
      <div className="flex justify-end"><QuietButton onClick={() => patch({ updateOpen: false })}>{t('updates.close')}</QuietButton></div>
    </div>
  </Modal>
}

export function UpdateSettings() {
  const preferences = useAppSelector(s => s.updatePreferences)
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const t = useT()
  useEffect(() => {
    let active = true
    void api().updates.preferences().then(updatePreferences => { if (active) patch({ updatePreferences }) }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  return <div className="space-y-2 border-t border-line pt-4" data-testid="update-settings">
    <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" checked={preferences?.automatic ?? false} disabled={busy || !preferences} onChange={event => {
      const enabled = event.target.checked
      setBusy(true); setFailed(false)
      void api().updates.setAutomatic(enabled).then(updatePreferences => patch({ updatePreferences })).catch(() => setFailed(true)).finally(() => setBusy(false))
    }} /><span>{t('updates.automatic')}</span></label>
    <p className="text-[12px] leading-5 text-muted">{t('updates.privacyHint')}</p>
    {failed && <p role="alert" className="text-[12px]" style={{ color: 'var(--warn-fg)' }}>{t('updates.error.storage')}</p>}
    <QuietButton onClick={() => void checkForUpdates()}>{t('updates.check')}</QuietButton>
  </div>
}
