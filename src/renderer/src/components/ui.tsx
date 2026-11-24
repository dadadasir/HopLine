import { useEffect, useRef, useState, useSyncExternalStore, type InputHTMLAttributes, type ReactNode } from 'react'
import { translate } from '../i18n'
import { dismissToast, errorText, patch, toast, useAppSelector, type ConfirmState } from '../state'

export function useT() {
  const locale = useAppSelector((state) => state.settings?.language ?? 'zh')
  return (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars)
}

export function Mark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" className="fill-accent-soft" />
      <path
        d="M8 21c3.4-1.4 4.6-5 5.4-7.6.7-2.2 1.5-4 3.4-4 2.3 0 2.7 2.6 3.4 5 .8 2.8 2 6.6 4.8 7.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        className="text-accent"
      />
      <circle cx="8" cy="21" r="1.45" className="fill-accent" />
      <circle cx="25" cy="22.2" r="1.45" className="fill-accent" />
    </svg>
  )
}

export function Field({
  label,
  children
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-muted">{label}</span>
      {children}
    </label>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`h-9 w-full px-3 text-[13px] ${props.className ?? ''}`} />
}

export function IconButton({
  label,
  children,
  onClick,
  active
}: {
  label: string
  children: ReactNode
  onClick?: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`no-drag grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-black/5 hover:text-ink dark:hover:bg-white/8 ${active ? 'bg-accent-soft text-accent' : ''}`}
    >
      {children}
    </button>
  )
}

export function PrimaryButton({
  children,
  onClick,
  type = 'button',
  value,
  form,
  disabled
}: {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  value?: string
  form?: string
  disabled?: boolean
}) {
  return (
    <button
      type={type}
      value={value}
      form={form}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap h-9 rounded-lg bg-accent px-3.5 text-[13px] font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function QuietButton({
  children,
  onClick,
  type = 'button',
  value,
  form,
  disabled
}: {
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  value?: string
  form?: string
  disabled?: boolean
}) {
  return (
    <button type={type} value={value} form={form} disabled={disabled} onClick={onClick} className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap h-9 rounded-lg px-3 text-[13px] disabled:opacity-50 text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/8">
      {children}
    </button>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  width = 'w-[560px]',
  placement = 'center',
  wideDrawer = false,
  footer
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
  placement?: 'center' | 'drawer'
  wideDrawer?: boolean
  footer?: ReactNode
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const t = useT()
  useEffect(() => {
    if (!open) return
    const element = dialog.current
    const previous = document.activeElement as HTMLElement | null
    if (!element?.contains(document.activeElement)) {
      const target = element?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? element?.querySelector<HTMLElement>('button:not([disabled])')
      ;(target ?? element)?.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (event.isComposing || dialogs[dialogs.length - 1] !== element) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close.current()
      } else if (event.key === 'Tab') {
        const targets = Array.from(element?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]') ?? []).filter((item) => item.getClientRects().length > 0)
        const first = targets[0], last = targets.at(-1)
        if (!first || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (element?.contains(document.activeElement) || document.activeElement === document.body) previous?.focus()
    }
  }, [open])
  if (!open) return null
  return (
    <div className={`fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] ${placement === 'drawer' ? 'flex justify-end' : 'grid place-items-start justify-center overflow-y-auto px-4 pt-[10vh] pb-10'}`} onMouseDown={onClose}>
      <div
        role="dialog"
        data-drawer={placement === 'drawer' ? (wideDrawer ? 'wide' : 'standard') : undefined}
        ref={dialog}
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
        className={`pop ${placement === 'center' ? width : ''} max-w-full border border-line bg-panel shadow-[var(--shadow)] ${placement === 'drawer' ? 'flex h-full min-h-0 flex-col border-y-0 border-r-0' : 'rounded-2xl'}`}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
          <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-black/5 dark:hover:bg-white/8" onClick={onClose} aria-label={t('dialog.close')}>
            ×
          </button>
        </div>
        <div className={`px-5 pb-5 ${placement === 'drawer' ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>{children}</div>
        {footer && <div className="shrink-0 border-t border-line bg-panel px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useAppSelector((state) => state.toasts)
  const t = useT()
  return (
    <div data-toast-stack className="pointer-events-none fixed right-5 bottom-5 z-50 flex max-h-[60vh] w-max max-w-[92vw] flex-col gap-2 overflow-y-auto">
      {toasts.map((item) => (
        <div key={item.id} role={item.tone === 'ok' ? 'status' : 'alert'} className={`pop pointer-events-auto max-w-xl rounded-xl border bg-panel px-3.5 py-2 text-[12px] shadow-lg ${item.tone === 'warning' ? 'border-amber-500 text-amber-800 dark:text-amber-200' : item.tone === 'err' ? 'border-line text-red-600 dark:text-red-300' : 'border-line text-ink'}`}>
          <div className="flex items-start gap-3">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.text}</span>
            <button type="button" aria-label={t('toast.dismiss')} onClick={() => dismissToast(item.id)}>×</button>
          </div>
          {item.action && (
            <button type="button" className="mt-2 underline underline-offset-2" onClick={() => {
              void item.action!.run().catch((error) => toast(errorText(error), 'err'))
            }}>{item.action.label}</button>
          )}
        </div>
      ))}
    </div>
  )
}

export function ConfirmDialog() {
  const confirm = useAppSelector((state) => state.confirm)
  const t = useT()
  if (!confirm) return null
  return (
    <Modal open title={confirm.title} onClose={() => closeConfirm()} width="w-[420px]">
      <p className="text-[13px] leading-6 text-muted">{confirm.body}</p>
      {confirm.details && (
        <details className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] text-muted">
          <summary className="cursor-pointer select-none font-medium text-muted hover:text-ink">{confirm.details.label}</summary>
          <p className="mt-2 leading-5">{confirm.details.body}</p>
        </details>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <QuietButton onClick={() => closeConfirm()}>{t('confirm.cancel')}</QuietButton>
        <button
          type="button"
          data-confirm-danger={confirm.danger || undefined}
          className={`h-9 rounded-lg px-3.5 text-[13px] font-medium ${confirm.danger ? 'bg-red-600 text-white' : 'bg-accent text-accent-ink'}`}
          onClick={() => void runConfirm(confirm)}
        >
          {confirm.confirm}
        </button>
      </div>
    </Modal>
  )
}

function closeConfirm() {
  patch({ confirm: null })
}

async function runConfirm(confirm: ConfirmState) {
  closeConfirm()
  try { await confirm.run() } catch (error) { toast(errorText(error), 'err') }
}

export function shortcutLabel(): string {
  return window.hopline?.platform === 'darwin' ? '⌘' : 'Ctrl+Shift+'
}


interface TextPromptOptions {
  title: string
  label?: string
  initialValue?: string
  confirm?: string
  validate?: (value: string) => string | null
  submit: (value: string) => Promise<void> | void
}

let textPrompt: (TextPromptOptions & { id: number }) | null = null
let nextPromptId = 0
const textPromptListeners = new Set<() => void>()
function emitTextPrompt() { textPromptListeners.forEach((listener) => listener()) }

/** Use with one TextPromptDialog mounted in the application shell. */
export function requestTextInput(options: TextPromptOptions): void {
  if (textPrompt) return
  textPrompt = { ...options, id: ++nextPromptId }
  emitTextPrompt()
}

export function TextPromptDialog() {
  const prompt = useSyncExternalStore((listener) => {
    textPromptListeners.add(listener)
    return () => { textPromptListeners.delete(listener) }
  }, () => textPrompt)
  return prompt ? <TextPromptForm key={prompt.id} prompt={prompt} /> : null
}

function TextPromptForm({ prompt }: { prompt: TextPromptOptions & { id: number } }) {
  const t = useT()
  const [value, setValue] = useState(prompt.initialValue ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const close = () => {
    if (submitting.current) return
    textPrompt = null
    emitTextPrompt()
  }
  const submit = async () => {
    if (submitting.current || !value.trim()) return
    const invalid = prompt.validate?.(value.trim())
    if (invalid) { setError(invalid); return }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await prompt.submit(value.trim())
      textPrompt = null
      emitTextPrompt()
    } catch (error) {
      setError(errorText(error))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return <Modal open title={prompt.title} onClose={close} width="w-[420px]">
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <Field label={prompt.label ?? prompt.title}>
        <TextInput autoFocus required value={value} readOnly={busy} onChange={(event) => { setValue(event.target.value); setError('') }} />
      </Field>
      {error && <p role="alert" className="mt-2 text-[12px] text-red-600 dark:text-red-300">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <QuietButton onClick={close}>{t('confirm.cancel')}</QuietButton>
        <PrimaryButton type="submit" disabled={busy || !value.trim()}>{prompt.confirm ?? t('host.save')}</PrimaryButton>
      </div>
    </form>
  </Modal>
}
