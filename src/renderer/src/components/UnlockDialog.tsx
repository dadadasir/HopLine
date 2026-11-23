import { PasswordInput } from './PasswordInput'
import { useState } from 'react'
import { errorText, patch, useAppSelector } from '../state'
import { unlockConnections } from '../state/tabs'
import { Field, Modal, PrimaryButton, QuietButton, useT } from './ui'

export function UnlockDialog() {
  const pending = useAppSelector((state) => Boolean(state.unlockPending?.length))
  return pending ? <UnlockForm /> : null
}

function UnlockForm() {
  const t = useT()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) patch({ unlockPending: [] }) }
  return (
    <Modal open title={t('backup.unlock')} onClose={close} width="w-[400px]">
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        void unlockConnections(password).catch((err) => setError(errorText(err))).finally(() => setBusy(false))
      }}>
        <p className="text-[12px] text-muted">{t('backup.unlockConnection')}</p>
        <Field label={t('backup.password')}>
          <PasswordInput secretLabel={t('backup.password')} autoFocus autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}
        <fieldset disabled={busy} className="flex justify-end gap-2">
          <QuietButton onClick={() => { close(); patch({ settingsOpen: 'backup' }) }}>{t('backup.openSettings')}</QuietButton>
          <PrimaryButton type="submit" disabled={busy || !password}>{t('backup.unlock')}</PrimaryButton>
        </fieldset>
      </form>
    </Modal>
  )
}
