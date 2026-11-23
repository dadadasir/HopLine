import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import { Copy, Eye, EyeOff } from 'lucide-react'
import type { HostSecretField } from '@shared/host-secrets'
import { api, errorText, toast, useAppSelector } from '../state'
import { TextInput, useT } from './ui'

interface SavedSecret { hostId: string; field: HostSecretField }

export function PasswordInput({ secretLabel, saved, onDraftChange, ...props }: InputHTMLAttributes<HTMLInputElement> & {
  secretLabel: string
  saved?: SavedSecret
  onDraftChange?: (value: string) => void
}) {
  const t = useT()
  const [visible, setVisible] = useState(false)
  const [revealed, setRevealed] = useState<string>()
  const [pending, setPending] = useState(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savedHost = saved?.hostId
  const route = useAppSelector(state => savedHost ? state.route : undefined)
  const unlocked = useAppSelector(state => savedHost ? state.settings?.backup.unlocked : undefined)
  useEffect(() => {
    if (!savedHost) return
    const clear = () => {
      generation.current++
      clearTimeout(timer.current)
      setPending(false)
      setVisible(false)
      setRevealed(undefined)
    }
    clear()
    const onVisibility = () => { if (document.hidden) clear() }
    document.addEventListener('visibilitychange', onVisibility)
    const off = api().on('hosts:clearRevealed', clear)
    return () => {
      off()
      document.removeEventListener('visibilitychange', onVisibility)
      generation.current++
      clearTimeout(timer.current)
    }
  }, [savedHost, route, unlocked])

  const toggle = async () => {
    if (visible || !saved || props.value || revealed !== undefined) {
      setVisible(!visible)
      return
    }
    const request = ++generation.current
    setPending(true)
    try {
      const value = await api().hosts.revealSecret(saved.hostId, saved.field)
      if (request !== generation.current) return
      setRevealed(value)
      setVisible(true)
      timer.current = setTimeout(() => { setRevealed(undefined); setVisible(false) }, 30_000)
    } catch (error) {
      if (request === generation.current) toast(t(errorText(error)), 'err')
    } finally {
      if (request === generation.current) setPending(false)
    }
  }
  const visibilityLabel = t(visible ? 'credentials.hideField' : 'credentials.showField', { field: secretLabel })
  const copyLabel = saved?.field === 'password' ? t('credentials.copyPassword') : t('credentials.copyField', { field: secretLabel })
  const copyRequiresSave = !!saved && !!props.value && props.value !== revealed
  const saveHint = copyRequiresSave ? t('credentials.saveBeforeCopy') : undefined
  const saveHintId = useId()
  const icon = 'rounded p-0.5 text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
  return <span className="relative block">
    <TextInput {...props} type={visible ? 'text' : 'password'} className={`${saved ? 'pr-[4.5rem]' : 'pr-10'} ${props.className ?? ''}`}
      value={onDraftChange ? props.value || revealed || '' : props.value}
      placeholder={saved ? '••••••••' : props.placeholder}
      onChange={onDraftChange ? event => {
        generation.current++
        setPending(false)
        const value = event.target.value
        if (!value && revealed !== undefined) {
          clearTimeout(timer.current)
          setRevealed(undefined)
        }
        onDraftChange(value === revealed ? '' : value)
      } : props.onChange} />
    <span className="absolute right-2 top-2 flex gap-1">
      <button type="button" disabled={props.disabled || pending} aria-label={visibilityLabel} title={visibilityLabel}
        aria-pressed={visible} className={icon} onClick={() => void toggle()}>
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      {saved && <span title={saveHint}>
        <button type="button" disabled={props.disabled || copyRequiresSave} aria-label={copyLabel}
          aria-describedby={saveHint ? saveHintId : undefined}
          title={saveHint ? undefined : copyLabel} className={`${icon} ${copyRequiresSave ? 'pointer-events-none' : ''}`}
          onClick={() => void api().hosts.copySecret(saved.hostId, saved.field)
            .then(() => toast(t(saved.field === 'password' ? 'credentials.passwordCopied' : 'credentials.secretCopied')))
            .catch(error => toast(t(errorText(error)), 'err'))}>
          <Copy className="h-4 w-4" />
        </button>
      </span>}
    </span>
    {saveHint && <span id={saveHintId} className="mt-1 block text-[12px] text-muted">{saveHint}</span>}
  </span>
}
