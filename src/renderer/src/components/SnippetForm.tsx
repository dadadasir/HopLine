import { useEffect, useState } from 'react'
import type { Snippet, SnippetInput } from '@shared/types'
import { api, errorText, getState, patch, toast, useAppSelector } from '../state'
import { extractVariables, matchSnippets, pasteSnippet } from '../logic/snippet'
import { terminalOf } from '../terminal/registry'
import { Field, Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'

function snippetError(error: unknown): string {
  return errorText(error).match(/snippet\.(invalid|missing|limit|terminal)\b/)?.[0] ?? errorText(error)
}

function insert(command: string, sessionId: string, values: Record<string, string> = {}): void {
  const term = terminalOf(sessionId)
  if (!term || getState().tabs.find((tab) => tab.id === sessionId)?.status !== 'connected') throw new Error('snippet.terminal')
  patch({ activeId: sessionId, route: { page: 'sessions' } })
  pasteSnippet(term, command, values)
  term.focus()
}

export function useSnippetActions() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const active = useAppSelector((state) => state.tabs.find((tab) => tab.id === state.activeId))
  const hosts = useAppSelector((state) => state.hosts)
  const t = useT()
  useEffect(() => {
    let stopped = false
    void api().snippets.list().then((items) => { if (!stopped) setSnippets(items) })
      .catch((error) => { if (!stopped) toast(t(snippetError(error)), 'err') })
    return () => { stopped = true }
  }, [])
  const hostId = active?.kind === 'ssh' && hosts.some((host) => host.id === active.hostId) ? active.hostId! : null
  return (active?.status === 'connected' ? matchSnippets(snippets, '', hostId) : []).map((snippet) => ({
    id: `snippet:${snippet.id}`, label: snippet.name, preview: snippet.command.replace(/[\r\n]+/g, ' '),
    matches: (query: string) => matchSnippets([snippet], query, hostId).length > 0,
    run: () => {
      if (extractVariables(snippet.command).length) patch({ snippetPrompt: { command: snippet.command, sessionId: active!.id } })
      else try { insert(snippet.command, active!.id) } catch (error) { toast(t(snippetError(error)), 'err') }
    }
  }))
}

export function SnippetVariables() {
  const prompt = useAppSelector((state) => state.snippetPrompt)
  return prompt ? <VariableForm key={`${prompt.sessionId}:${prompt.command}`} command={prompt.command} sessionId={prompt.sessionId} /> : null
}

function VariableForm({ command, sessionId }: { command: string; sessionId: string }) {
  const variables = extractVariables(command)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(variables.map((name) => [name, ''])))
  const t = useT()
  const close = () => patch({ snippetPrompt: null })
  return (
    <Modal open title={t('snippet.variables')} onClose={close}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault()
        try { insert(command, sessionId, values); close() }
        catch (error) { toast(t(snippetError(error)), 'err') }
      }}>
        {variables.map((name, index) => (
          <Field key={name} label={name}>
            <TextInput autoFocus={index === 0} value={values[name]} onChange={(event) => setValues({ ...values, [name]: event.target.value })} />
          </Field>
        ))}
        <div className="flex justify-end gap-2">
          <QuietButton onClick={close}>{t('host.cancel')}</QuietButton>
          <PrimaryButton type="submit">{t('snippet.insert')}</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}

export function SnippetSettings() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<SnippetInput | null>(null)
  const [error, setError] = useState('')
  const hosts = useAppSelector((state) => state.hosts)
  const t = useT()
  useEffect(() => { void api().snippets.list().then(setSnippets).catch((error) => setError(snippetError(error))) }, [])
  const scope = (item: SnippetInput) => item.hostId === null ? 'global' : hosts.some((host) => host.id === item.hostId) ? item.hostId : 'invalidHost'
  const groups = new Map<string, Snippet[]>()
  for (const item of snippets) groups.set(scope(item), [...(groups.get(scope(item)) ?? []), item])
  const remove = (item: Snippet) => patch({ confirm: {
    title: t('snippet.delete'), body: t('snippet.deleteBody', { name: item.name }), confirm: t('host.delete'), danger: true,
    run: async () => {
      try {
        await api().snippets.delete(item.id)
        setSnippets((items) => items.filter((entry) => entry.id !== item.id))
      } catch (error) { setError(snippetError(error)) }
    }
  } })
  return (
    <div className="min-w-0 space-y-3">
      <QuietButton onClick={() => setEditing({ name: '', command: '', hostId: null })}>{t('snippet.new')}</QuietButton>
      {editing && <SnippetEditor key={editing.id ?? 'new'} input={editing} onClose={() => setEditing(null)} onSave={(saved) => {
        setSnippets((items) => items.some((item) => item.id === saved.id) ? items.map((item) => item.id === saved.id ? saved : item) : [...items, saved])
        setEditing(null)
      }} />}
      {error && <p role="alert" className="text-[12px] text-red-600">{t(error)}</p>}
      {!snippets.length && <p className="text-[12px] text-muted">{t('snippet.empty')}</p>}
      <div className="max-h-72 space-y-3 overflow-y-auto">
        {[...groups].map(([id, items]) => <section key={id}>
          <h3 className="text-[12px] text-muted">{id === 'global' || id === 'invalidHost' ? t(`snippet.${id}`) : hosts.find((host) => host.id === id)?.name}</h3>
          {items.map((item) => <div key={item.id} className="flex items-center gap-1 border-b border-line py-1">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px]">{item.name}</p>
              <p className="truncate whitespace-nowrap text-[12px] text-muted">{item.command}</p>
            </div>
            <QuietButton onClick={() => setEditing(item)}>{t('host.edit')}</QuietButton>
            <QuietButton onClick={() => remove(item)}>{t('host.delete')}</QuietButton>
          </div>)}
        </section>)}
      </div>
    </div>
  )
}

function SnippetEditor({ input, onSave, onClose }: { input: SnippetInput; onSave: (saved: Snippet) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(input)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const hosts = useAppSelector((state) => state.hosts)
  const t = useT()
  return (
    <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(event) => {
      event.preventDefault()
      if (saving) return
      setSaving(true)
      void api().snippets.save(draft).then(onSave).catch((error) => setError(snippetError(error))).finally(() => setSaving(false))
    }}>
      <Field label={t('host.name')}>
        <TextInput autoFocus required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </Field>
      <Field label={t('snippet.command')}>
        <textarea required maxLength={4000} rows={4} className="w-full p-2 font-mono text-[12px]" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
      </Field>
      <Field label={t('snippet.scope')}>
        <select className="h-9 w-full px-2 text-[13px]" value={draft.hostId ?? ''} onChange={(event) => setDraft({ ...draft, hostId: event.target.value || null })}>
          <option value="">{t('snippet.global')}</option>
          {draft.hostId && !hosts.some((host) => host.id === draft.hostId) && <option value={draft.hostId}>{t('snippet.invalidHost')}</option>}
          {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
        </select>
      </Field>
      {error && <p role="alert" className="text-[12px] text-red-600">{t(error)}</p>}
      <div className="flex justify-end gap-2">
        <QuietButton onClick={onClose}>{t('host.cancel')}</QuietButton>
        <PrimaryButton type="submit" disabled={saving}>{t('host.save')}</PrimaryButton>
      </div>
    </form>
  )
}
