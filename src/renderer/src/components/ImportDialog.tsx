import { useEffect, useState } from 'react'
import type { ImportCandidate, SshConfigPreview } from '@shared/types'
import { api, errorText, patch, toast, useAppSelector } from '../state'
import { Field, Modal, PrimaryButton, TextInput, useT } from './ui'

export function ImportDialog() {
  const open = useAppSelector((state) => state.importSshConfigOpen)
  return open ? <ImportForm /> : null
}

function ImportForm() {
  const t = useT()
  const groups = useAppSelector((state) => state.groups)
  const [preview, setPreview] = useState<SshConfigPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [missingUsers, setMissingUsers] = useState<Set<string>>(new Set())
  const [groupId, setGroupId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = (host: ImportCandidate) => Boolean(host.username.trim()) && host.jumps.every((jump) => jump.username.trim())
  useEffect(() => {
    let active = true
    void api().hosts.importSshConfig.preview().then((result) => {
      if (!active) return
      setPreview(result)
      setMissingUsers(new Set(result.hosts.flatMap((host) => [
        ...(!host.username.trim() ? [host.name] : []), ...host.jumps.flatMap((jump, index) => !jump.username.trim() ? [`${host.name}:${index}`] : [])
      ])))
      setSelected(new Set(result.hosts.filter((host) => !host.duplicateOf && ready(host)).map((host) => host.name)))
    }).catch((error) => { if (active) setError(errorText(error)) })
    return () => { active = false }
  }, [])
  const chosen = preview?.hosts.filter((host) => selected.has(host.name) && ready(host)) ?? []
  const username = (host: ImportCandidate, value: string, jumpIndex?: number) => {
    setPreview((current) => current && ({ ...current, hosts: current.hosts.map((item) => item.name !== host.name ? item : {
      ...item, ...(jumpIndex === undefined ? { username: value } : { jumps: item.jumps.map((jump, index) => index === jumpIndex ? { ...jump, username: value } : jump) })
    }) }))
  }
  const apply = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api().hosts.importSshConfig.apply(chosen, groupId || null)
      toast(t('importSsh.result', result), result.failed ? 'warning' : 'ok')
      patch({ importSshConfigOpen: false })
    } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  return (
    <Modal open title={t('importSsh.title')} onClose={() => { if (!busy) patch({ importSshConfigOpen: false }) }} width="w-[820px]">
      {!preview && !error && <p className="text-[13px] text-muted">{t('importSsh.loading')}</p>}
      {preview && <>
        <div className="scroll-thin max-h-[45vh] space-y-2 overflow-auto">
          {!preview.hosts.length && <p className="text-[13px] text-muted">{t('importSsh.empty')}</p>}
          {preview.hosts.map((host) => <div key={host.name} className="flex items-center gap-3 rounded-lg border border-line p-2 text-[12px]">
            <input type="checkbox" aria-label={host.name} disabled={busy || !ready(host)} checked={selected.has(host.name) && ready(host)} onChange={(event) => {
              const next = new Set(selected)
              if (event.target.checked) next.add(host.name); else next.delete(host.name)
              setSelected(next)
            }} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-medium">{host.name} {host.duplicateOf && <span className="text-muted">{t('importSsh.duplicate')}</span>}</div>
              <div className="break-all text-muted">{host.username}@{host.host}:{host.port}</div>
              {missingUsers.has(host.name) && <TextInput aria-label={`${host.name} ${t('host.user')}`} placeholder={t('importSsh.user')} value={host.username} disabled={busy} onChange={(event) => username(host, event.target.value)} />}
              {host.jumps.length > 0 && <div>{host.jumpNames.join(' → ')}</div>}
              {host.jumps.map((jump, index) => missingUsers.has(`${host.name}:${index}`) && <TextInput key={index} aria-label={`${host.jumpNames[index]} ${t('host.user')}`} placeholder={`${host.jumpNames[index]}: ${t('importSsh.user')}`} value={jump.username} disabled={busy} onChange={(event) => username(host, event.target.value, index)} />)}
            </div>
            <span>{t(host.authType === 'agent' ? 'auth.agent' : 'auth.key')}</span>
            {!!host.warnings.length && <span role="img" aria-label={host.warnings.join('\n')} title={host.warnings.join('\n')}>⚠</span>}
          </div>)}
        </div>
        {!!preview.warnings.length && <details className="mt-3 text-[12px] text-muted"><summary>{t('importSsh.warnings', { count: preview.warnings.length })}</summary><ul className="max-h-24 overflow-auto">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
        <div className="mt-4 flex items-end justify-between gap-3">
          <Field label={t('importSsh.group')}><select disabled={busy} value={groupId} onChange={(event) => setGroupId(event.target.value)} className="h-9 px-2 text-[13px]">
            <option value="">{t('sidebar.ungrouped')}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select></Field>
          <PrimaryButton disabled={busy || !chosen.length} onClick={() => void apply()}>{t('importSsh.apply', { count: chosen.length })}</PrimaryButton>
        </div>
      </>}
      {error && <p role="alert" className="mt-3 text-[12px] text-red-600">{error}</p>}
    </Modal>
  )
}
