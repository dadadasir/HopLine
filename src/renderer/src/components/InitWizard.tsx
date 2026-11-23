import { PasswordInput } from './PasswordInput'
import { useEffect, useState } from 'react'
import type { InitAuth, InitIdentity, RunbookPreview, RunbookProgress } from '@shared/types'
import type { Params, RunbookSummary, StepResult } from '../../../core/runbook/types'
import { initRunbook } from '../../../core/runbook/init'
import { api, patch, useAppSelector } from '../state'
import { runbookError } from '../logic/runbook'
import { RunbookSteps, RunbookSummaryView } from './RunbookDialog'
import { Field, Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'

export function InitWizard() {
  const hostId = useAppSelector((state) => state.initHost)
  return hostId ? <Wizard key={hostId} hostId={hostId} /> : null
}
function Wizard({ hostId }: { hostId: string }) {
  const t = useT(), host = useAppSelector((state) => state.hosts.find((host) => host.id === hostId))
  const memory = useAppSelector((state) => state.snapshots[hostId]?.snapshot?.memory)
  const [params, setParams] = useState<Params>({ USER: '', PUBKEY: '', USER_PASSWORD: '', SWAP_MB: memory && memory.status !== 'unavailable' && (memory.data.totalBytes ?? 0) >= 2 * 1024 ** 3 ? '1024' : '2048', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
  const [auth, setAuth] = useState<InitAuth>({ type: 'privateKey', privateKeyPath: '' }), [identities, setIdentities] = useState<InitIdentity[]>([])
  const [confirm, setConfirm] = useState(''), [page, setPage] = useState(1), [selected, setSelected] = useState(initRunbook.steps.map((step) => step.id))
  const [plan, setPlan] = useState<RunbookPreview>(), [password, setPassword] = useState(''), [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, StepResult>>({}), [summary, setSummary] = useState<RunbookSummary>(), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  useEffect(() => { void api().init.identities().then(setIdentities).catch((err) => setError(runbookError(err))) }, [])
  useEffect(() => api().on('runbook:progress', (event: RunbookProgress) => {
    if (event.hostId === hostId && event.planId === plan?.id) setResults((current) => ({ ...current, [event.result.stepId]: event.result }))
  }), [hostId, plan?.id])
  const check = async () => {
    setError('')
    if (params.USER_PASSWORD !== confirm) { setError('init.passwordMismatch'); return }
    setBusy(true)
    try { setPlan(await api().init.plan(hostId, params, auth)); setPage(2) }
    catch (err) { setError(runbookError(err)) } finally { setBusy(false) }
  }
  const run = async () => {
    if (!plan) return
    setBusy(true); setPage(3); setError(''); setPassword(''); setConfirm(''); setParams({ ...params, USER_PASSWORD: '' })
    try { setSummary(await api().runbook.run(hostId, plan.id, selected, password || undefined)) }
    catch (err) { setError(runbookError(err)) } finally { setBusy(false) }
  }
  const save = async () => {
    if (!host) return
    setBusy(true); setError('')
    try {
      await api().hosts.save({ id: host.id, groupId: host.groupId, name: host.name, host: host.host, port: host.port,
        username: params.USER, authType: auth.type, password: null, privateKey: null,
        privateKeyPath: auth.type === 'privateKey' ? auth.privateKeyPath : null, passphrase: auth.type === 'privateKey' ? auth.passphrase ?? null : null,
        agent: auth.type === 'agent' ? { socket: auth.socket ?? null, identityFile: null, forward: false } : null })
      patch({ hosts: await api().hosts.list() }); setSaved(true)
    } catch (err) { setError(runbookError(err)) } finally { setBusy(false) }
  }
  // Already-satisfied steps stay checked but never run, so they don't count.
  const runnable = plan ? selected.filter((id) => plan.steps.some((step) => step.id === id && step.status === 'needed')).length : 0
  return <Modal open title={`${t('init.title')} · ${host?.name ?? t('overview.missing')} · ${page}/3`} width="w-[720px]" onClose={() => { if (!busy) { void api().runbook.cancel(hostId).catch(() => {}); patch({ initHost: null }) } }}>
    <div className="max-h-[70vh] space-y-4 overflow-auto">
      <p className="font-medium">{t(`init.page${page}`)}</p>
      {page === 1 ? <>
        <Field label={t('init.identity')}><select className="h-9 w-full" disabled={busy} defaultValue="" onChange={(event) => {
          const identity = identities[Number(event.target.value)]
          if (event.target.value !== '' && identity) { setParams({ ...params, PUBKEY: identity.publicKey }); setAuth(identity.auth) }
        }}><option value="">{t('init.paste')}</option>{identities.map((identity, index) => <option key={index} value={index}>{identity.label}</option>)}</select></Field>
        {(initRunbook.params ?? []).map((param) => <Field key={param.name} label={t(param.label)}>{param.secret ? <PasswordInput secretLabel={t(param.label)} disabled={busy} autoComplete="off" value={params[param.name]} onChange={(event) => setParams({ ...params, [param.name]: event.target.value })} /> : <TextInput disabled={busy} autoComplete="off" value={params[param.name]} onChange={(event) => setParams({ ...params, [param.name]: event.target.value })} />}</Field>)}
        <Field label={t('init.confirmPassword')}><PasswordInput secretLabel={t('init.confirmPassword')} disabled={busy}  autoComplete="off" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Field>
        <Field label={t('init.auth')}><select className="h-9 w-full" disabled={busy} value={auth.type} onChange={(event) => setAuth({ type: event.target.value as InitAuth['type'] })}><option value="privateKey">{t('init.privateKey')}</option><option value="agent">ssh-agent</option></select></Field>
        {auth.type === 'privateKey' ? (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={t('init.privateKey')}>
                <TextInput disabled={busy} value={auth.privateKeyPath ?? ''} onChange={(event) => setAuth({ ...auth, privateKeyPath: event.target.value || undefined })} spellCheck={false} />
              </Field>
            </div>
            <QuietButton disabled={busy} onClick={() => void api().dialog.pick('key').then((files) => { if (files[0]) setAuth({ ...auth, privateKeyPath: files[0] }) })}>{t('host.choose')}</QuietButton>
          </div>
        ) : (
          <Field label={t(api().platform === 'win32' ? 'init.socketWin' : 'init.socket')}>
            <TextInput disabled={busy} value={auth.socket ?? ''} placeholder={api().platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : ''} onChange={(event) => setAuth({ ...auth, socket: event.target.value || undefined })} spellCheck={false} />
          </Field>
        )}
        {auth.type === 'privateKey' && <Field label={t('init.passphrase')}><PasswordInput secretLabel={t('init.passphrase')} disabled={busy} value={auth.passphrase ?? ''} onChange={(event) => setAuth({ ...auth, passphrase: event.target.value })} /></Field>}
        {initRunbook.steps.map((step) => <label key={step.id} className="flex items-center gap-2"><input disabled={busy} type="checkbox" checked={selected.includes(step.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, step.id] : selected.filter((id) => id !== step.id))} />{t(step.title)}</label>)}
        <PrimaryButton disabled={busy || !host || !selected.length} onClick={() => void check()}>{t(busy ? 'runbook.checking' : 'runbook.check')}</PrimaryButton>
      </> : <>
        <div className="space-y-2 rounded border border-amber-500 bg-amber-500/10 p-3 text-[13px]"><p>{t('init.rule1')}</p><p>{t('init.rule2')}</p></div>
        {plan && <RunbookSteps book={initRunbook} {...{ plan, results, selected, setSelected }} disabled={busy || page === 3} />}
        {page === 2 && <>
          {plan?.sudo === 'password' && <Field label={t('runbook.password')}><PasswordInput secretLabel={t('runbook.password')} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>}
          <QuietButton onClick={() => { setPage(1); setPlan(undefined); setPassword('') }}>{t('init.back')}</QuietButton>
          <PrimaryButton disabled={busy || !host || !runnable} onClick={() => void run()}>{t('runbook.run', { count: runnable })}</PrimaryButton>
        </>}
        {page === 3 && busy && <QuietButton onClick={() => { void api().runbook.cancel(hostId).catch((err) => setError(runbookError(err))) }}>{t('runbook.cancel')}</QuietButton>}
        {summary && <><RunbookSummaryView summary={summary} /><p>{t('init.recommend')}</p>
          <PrimaryButton disabled={busy || saved || !host || !Object.values(results).some((result) => result.gate?.ok)} onClick={() => void save()}>{t(saved ? 'init.saved' : 'init.save')}</PrimaryButton>
          {!Object.values(results).some((result) => result.gate?.ok) && <p className="text-muted">{t('init.saveBlocked')}</p>}
        </>}
      </>}
      {error && <p role="alert" className="text-red-600 dark:text-red-300">{t(error)}</p>}
    </div>
  </Modal>
}
