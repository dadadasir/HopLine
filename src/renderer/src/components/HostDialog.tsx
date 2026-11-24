import { parseSshAddress, recognizeHostText, type RecognizedConnection } from '../../../core/host-recognition'
import { PasswordInput } from './PasswordInput'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ArrowDown, ChevronRight, Trash2 } from 'lucide-react'
import type { AuthType, ForwardRule, HostPublic, JumpPublic, ProxyType } from '@shared/types'
import { api, connectHost, errorText, patch, toast } from '../state'
import { Field, Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'
import { useAppSelector } from '../state'
import { isLockedError } from '../logic/locked-error'
import { connectionTimingDraft } from '../logic/host-connection'
import { MASTER_PASSWORD_REQUIRED } from '@shared/types'

const agentSockets = {
  system: '',
  onePassword: '~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock',
  secretive: '~/Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh',
  pageant: 'pageant'
}

export function HostDialog() {
  const mode = useAppSelector((state) => state.hostDialog)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const formId = useId()
  const t = useT()
  useEffect(() => { setError('') }, [mode])
  if (!mode) return null
  const host = typeof mode === 'object' ? mode : null
  const footer = (
    <div>
      {error && <p role="alert" className="mb-2.5 text-[12px]" style={{ color: 'var(--risk-fg)' }}>{error}</p>}
      <div className="flex justify-end gap-2">
        <QuietButton onClick={() => { if (!saving) patch({ hostDialog: false }) }}>{t('host.cancel')}</QuietButton>
        {host ? <PrimaryButton type="submit" form={formId} disabled={saving}>{saving ? t('host.saving') : t('host.save')}</PrimaryButton> : <>
          <QuietButton type="submit" form={formId} disabled={saving}>{t('host.save')}</QuietButton>
          <PrimaryButton type="submit" form={formId} value="connect" disabled={saving}>{saving ? t('host.saving') : t('host.saveAndConnect')}</PrimaryButton>
        </>}
      </div>
    </div>
  )
  return (
    <Modal open title={host ? t('host.editTitle') : t('host.new')} onClose={() => { if (!saving) patch({ hostDialog: false }) }} placement="drawer" footer={footer}>
      <HostForm key={host?.id ?? (mode === 'recognize' ? 'recognize' : 'new')} formId={formId} host={host} recognize={mode === 'recognize'} onBusy={setSaving} onError={setError} />
    </Modal>
  )
}

function HostForm({ formId, host, recognize, onBusy, onError }: { formId: string; host: HostPublic | null; recognize: boolean; onBusy: (busy: boolean) => void; onError: (message: string) => void }) {
  const t = useT()
  const groups = useAppSelector((state) => state.groups)
  const [persistent, setPersistent] = useState(host?.persistent ?? false)
  const [name, setName] = useState(host?.name ?? '')
  const [note, setNote] = useState(host?.meta.note ?? '')
  const [address, setAddress] = useState(host?.host ?? '')
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [username, setUsername] = useState(host?.username ?? 'root')
  const [groupId, setGroupId] = useState(host?.groupId ?? '')
  const [newGroupName, setNewGroupName] = useState('')
  const [recognizing, setRecognizing] = useState(recognize)
  const [sourceText, setSourceText] = useState('')
  const [recognized, setRecognized] = useState<RecognizedConnection[]>([])
  const [candidate, setCandidate] = useState<number | null>(null)
  const [recognitionError, setRecognitionError] = useState('')
  const fillConnection = (item: RecognizedConnection) => {
    setAddress(item.host); setPort(item.port === null ? '' : String(item.port))
    if (item.username) setUsername(item.username)
    if (item.password) { setPassword(item.password); setAuthType('password') }
  }
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)
  const [authType, setAuthType] = useState<AuthType>(host?.authType ?? 'password')
  const [agentPreset, setAgentPreset] = useState(() => Object.entries(agentSockets).find(([, socket]) => socket === (host?.agent?.socket ?? ''))?.[0] ?? 'custom')
  const [agentSocket, setAgentSocket] = useState(host?.agent?.socket ?? '')
  const [identityFile, setIdentityFile] = useState(host?.agent?.identityFile ?? '')
  const [agentForward, setAgentForward] = useState(host?.agent?.forward ?? false)
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState(host?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [clearPassphrase, setClearPassphrase] = useState(false)
  const [connectionTimeout, setConnectionTimeout] = useState(host?.connectionTimeoutSec == null ? '' : String(host.connectionTimeoutSec))
  const [keepaliveInterval, setKeepaliveInterval] = useState(host?.keepaliveIntervalSec == null ? '' : String(host.keepaliveIntervalSec))
  const [startup, setStartup] = useState(host?.startupCommand ?? '')
  const [useProxy, setUseProxy] = useState(Boolean(host?.proxy))
  const [proxyType, setProxyType] = useState<ProxyType>(host?.proxy?.type ?? 'socks5')
  const [proxyHost, setProxyHost] = useState(host?.proxy?.host ?? '')
  const [proxyPort, setProxyPort] = useState(String(host?.proxy?.port ?? 1080))
  const [proxyUser, setProxyUser] = useState(host?.proxy?.username ?? '')
  const [proxyPassword, setProxyPassword] = useState('')
  const [jumps, setJumps] = useState(() => (host?.jumps ?? []).map(jumpDraft))
  const [forwards, setForwards] = useState<ForwardRule[]>(host?.forwards ?? [])
  const [forwardsOpen, setForwardsOpen] = useState(Boolean(host?.forwards?.length))
  const updateForward = (id: string, change: Partial<ForwardRule>) => setForwards(forwards.map((rule) => rule.id === id ? { ...rule, ...change } : rule))
  const zh = useAppSelector((state) => state.settings?.language !== 'en')
  const [advanced, setAdvanced] = useState(Boolean(host && (host.persistent || host.proxy || host.jumps.length || host.forwards.length || host.startupCommand || host.connectionTimeoutSec != null || host.keepaliveIntervalSec != null)))
  const advancedSummary = [connectionTimeout.trim() && t('host.connectionTimeout'), keepaliveInterval.trim() && t('host.keepaliveInterval'), persistent && (zh ? '持久会话' : 'Persistent'), useProxy && t('host.proxy'), jumps.length > 0 && t('host.jump'), forwards.length > 0 && t('forward.title'), startup.trim() && t('host.startup')].filter(Boolean).join(' · ')

  const save = async (connect: boolean) => {
    if (submitting.current) return
    onError('')
    if (groupId === '__new__' && groups.some((group) => group.name === newGroupName.trim())) {
      onError(t('host.groupExists'))
      return
    }
    submitting.current = true
    setSaving(true)
    onBusy(true)
    try {
      const timing = connectionTimingDraft(connectionTimeout, keepaliveInterval)
      const saved = await api().hosts.save({
        ...timing,
        persistent,
        forwards,
        id: host?.id,
        groupId: groupId === '__new__' ? null : groupId || null,
        newGroupName: groupId === '__new__' ? newGroupName.trim() : undefined,
        name,
        ...(note !== (host?.meta.note ?? '') ? { meta: { note: note || null } } : {}),
        host: address,
        port: Number(port),
        username,
        authType,
        agent: authType === 'agent' ? {
          socket: (agentPreset === 'custom' ? agentSocket : agentSockets[agentPreset as keyof typeof agentSockets]) || null,
          identityFile: identityFile.trim() || null,
          forward: agentForward
        } : null,
        password: clearPassword ? null : password || undefined,
        privateKey: privateKey.trim() ? privateKey : undefined,
        privateKeyPath,
        passphrase: clearPassphrase ? null : passphrase || undefined,
        startupCommand: startup,
        proxy: useProxy
          ? {
              type: proxyType,
              host: proxyHost,
              port: Number(proxyPort),
              username: proxyUser,
              password: proxyPassword || undefined
            }
          : null,
        jumps: jumps.map((jump) => ({
          agent: jump.authType === 'agent' ? {
            socket: (jump.agentPreset === 'custom' ? jump.agentSocket : agentSockets[jump.agentPreset as keyof typeof agentSockets]) || null,
            identityFile: jump.identityFile.trim() || null, forward: false
          } : null,
          host: jump.host, port: Number(jump.port), username: jump.username, authType: jump.authType,
          password: jump.password || undefined, privateKey: jump.privateKey.trim() ? jump.privateKey : undefined,
          privateKeyPath: jump.privateKeyPath, passphrase: jump.passphrase || undefined
        }))
      })
      patch({ hostDialog: false })
      toast(t('toast.saved'))
      if (connect) void connectHost(saved)
    } catch (err) {
      onError(t(errorText(err)))
      if (isLockedError(err)) toast(MASTER_PASSWORD_REQUIRED, 'err', {
        duration: 0,
        action: { label: t('backup.openSettings'), run: async () => { patch({ settingsOpen: 'backup' }) } }
      })
    } finally {
      submitting.current = false
      setSaving(false)
      onBusy(false)
    }
  }

  return (
    <form
      id={formId}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'connect')
      }}
    >
      {!host && <div className="flex justify-end"><QuietButton onClick={() => setRecognizing(true)}>{t('credentials.fromText')}</QuietButton></div>}
      <Modal open={recognizing} title={t('credentials.fromText')} onClose={() => { setRecognizing(false); setSourceText(''); setRecognized([]); setRecognitionError('') }}>
        <p className="mb-3 text-sm text-muted">{t('credentials.recognizeHint')}</p>
        <textarea data-recognition-text aria-label={t('credentials.sourceText')} className="min-h-40 w-full p-3 text-sm" value={sourceText} maxLength={100000} onChange={event => { setSourceText(event.target.value); setRecognized([]); setRecognitionError('') }} spellCheck={false} />
        {recognized.length > 0 && <Field label={t('credentials.chooseAddress')}><select data-recognition-address className="h-9 w-full px-2" value={candidate ?? ''} onChange={event => setCandidate(Number(event.target.value))}><option value="" disabled>{t('credentials.chooseAddress')}</option>{recognized.map((item, index) => <option key={item.host} value={index}>{item.host}{item.port === null ? '' : `:${item.port}`}{item.username ? ` · ${item.username}` : ''}</option>)}</select></Field>}
        {recognitionError && <p role="alert" className="mt-2 text-sm text-red-600">{recognitionError}</p>}
        <div className="mt-4 flex justify-end gap-2"><QuietButton onClick={() => { const result = recognizeHostText(sourceText); setRecognized(result); setCandidate(result.length === 1 ? 0 : null); setRecognitionError(result.length ? '' : t('credentials.noAddress')) }}>{t('credentials.recognize')}</QuietButton><PrimaryButton disabled={candidate === null || !recognized[candidate]} onClick={() => { fillConnection(recognized[candidate!]!); setRecognizing(false); setSourceText(''); setRecognized([]) }}>{t('credentials.apply')}</PrimaryButton></div>
      </Modal>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('host.name')}><TextInput maxLength={80} value={name} placeholder={t('host.namePlaceholder')} onChange={(event) => setName(event.target.value)} autoFocus /></Field>
        <Field label={t('host.group')}>
          <select value={groupId} onChange={(event) => setGroupId(event.target.value)} className="h-9 w-full px-2 text-[13px]">
            <option value="">{t('sidebar.ungrouped')}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
            <option value="__new__">+ {t('sidebar.group')}</option>
          </select>
        </Field>
        <Field label={t('host.address')}><TextInput required maxLength={255} value={address} onChange={(event) => setAddress(event.target.value)} onPaste={event => { if (host) return; const value = event.clipboardData.getData('text'); if (!/^ssh\s|@|^\[.+\]:\d+$|^[^:]+:\d+$/.test(value.trim())) return; const parsed = parseSshAddress(value); if (parsed) { event.preventDefault(); fillConnection(parsed) } }} spellCheck={false} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('host.port')}><TextInput required type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} /></Field>
          <Field label={t('host.user')}><TextInput required maxLength={128} value={username} onChange={(event) => setUsername(event.target.value)} spellCheck={false} /></Field>
        </div>
      </div>
      {groupId === '__new__' && <div className="rounded-lg border border-line p-3">
        <Field label={t('host.newGroupName')}><TextInput required maxLength={40} value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} /></Field>
        <p className="mt-2 text-[12px] text-muted">{t('host.newGroupHint')}</p>
      </div>}
      <div>
        <div className="mb-1.5 text-[12px] text-muted">{t('host.auth')}</div>
        <div className="inline-flex rounded-lg border border-line p-0.5">
          {(['password', 'privateKey', 'keyboard-interactive', 'agent'] as AuthType[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setAuthType(item)}
              className={`h-7 rounded-md px-3 text-[12px] ${authType === item ? 'bg-accent-soft text-accent' : 'text-muted'}`}
            >
              {t(item === 'password' ? 'auth.password' : item === 'privateKey' ? 'auth.key' : item === 'agent' ? 'auth.agent' : 'auth.kbd')}
            </button>
          ))}
        </div>
      </div>
      {authType !== 'privateKey' && authType !== 'agent' && (
        <Field label={t('host.password')}>
          <PasswordInput secretLabel={t('host.password')} value={password} saved={host?.hasPassword ? { hostId: host.id, field: 'password' } : undefined} onDraftChange={setPassword} autoComplete="off" />
          {host?.hasPassword && (
            <label className="mt-1 flex items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} />
              {t('host.clear')}
            </label>
          )}
        </Field>
      )}
      {authType === 'agent' && (
        <div className="space-y-3">
          <p className="text-[12px] leading-5 text-muted">{t('host.agentHint')}</p>
          <AgentFields preset={agentPreset} socket={agentSocket} identity={identityFile}
            onPreset={setAgentPreset} onSocket={setAgentSocket} onIdentity={setIdentityFile} />
          <label className="flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={agentForward} onChange={(event) => setAgentForward(event.target.checked)} />
            {t('agent.forward')}
            <span className="text-muted">{t('agent.risk')}</span>
          </label>
        </div>
      )}
      {authType === 'privateKey' && (
        <div className="space-y-3">
          <Field label={t('host.key')}>
            <textarea value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} placeholder={host?.hasPrivateKey ? t('host.keep') : ''} rows={4} className="w-full px-3 py-2 font-mono text-[12px]" spellCheck={false} />
          </Field>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={t('host.keyPath')}>
                <TextInput value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} spellCheck={false} />
              </Field>
            </div>
            <QuietButton
              onClick={() =>
                void api().dialog.pick('key').then((files) => {
                  if (files[0]) setPrivateKeyPath(files[0])
                })
              }
            >
              {t('host.choose')}
            </QuietButton>
          </div>
          <Field label={t('host.passphrase')}>
            <PasswordInput secretLabel={t('host.passphrase')} value={passphrase} saved={host?.hasPassphrase ? { hostId: host.id, field: 'passphrase' } : undefined} onDraftChange={setPassphrase} autoComplete="off" />
            {host?.hasPassphrase && (
              <label className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                <input type="checkbox" checked={clearPassphrase} onChange={(event) => setClearPassphrase(event.target.checked)} />
                {t('host.clear')}
              </label>
            )}
          </Field>
        </div>
      )}
      <Field label={t('overview.note')}>
        <textarea rows={2} maxLength={2000} className="w-full px-2 py-1.5 text-[13px]" value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className="flex w-full items-center gap-2 border-t border-line pt-4 text-left text-[13px]">
        <ChevronRight className={`h-3.5 w-3.5 text-muted transition-transform ${advanced ? 'rotate-90' : ''}`} />
        <span className="font-medium">{zh ? '高级设置' : 'Advanced'}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{advancedSummary || (zh ? '通常无需调整' : 'Usually no changes needed')}</span>
      </button>
      <div className={advanced ? 'space-y-4' : 'hidden'}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('host.connectionTimeout')}>
          <TextInput name="connectionTimeoutSec" inputMode="numeric" className="font-mono" value={connectionTimeout} placeholder={t('host.connectionTimeoutDefault')} aria-describedby="connection-timeout-hint" onChange={(event) => setConnectionTimeout(event.target.value)} />
          <p id="connection-timeout-hint" className="mt-1 text-[12px] leading-5 text-muted">{t('host.connectionTimeoutHint')}</p>
        </Field>
        <Field label={t('host.keepaliveInterval')}>
          <TextInput name="keepaliveIntervalSec" inputMode="numeric" className="font-mono" value={keepaliveInterval} placeholder={t('host.keepaliveDefault')} aria-describedby="keepalive-interval-hint" onChange={(event) => setKeepaliveInterval(event.target.value)} />
          <p id="keepalive-interval-hint" className="mt-1 text-[12px] leading-5 text-muted">{t('host.keepaliveHint')}</p>
        </Field>
      </div>
      <div className="rounded-lg border border-line p-3">
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={persistent} onChange={(event) => setPersistent(event.target.checked)} />{t('persistent.default')}</label>
        <p className="mt-1 text-[12px] leading-5 text-muted">{t('host.persistentHint')}</p>
      </div>
      <Disclosure title={t('host.proxy')} open={useProxy} onToggle={setUseProxy}>
        <div className="grid grid-cols-2 gap-3">
          <div className="inline-flex h-9 items-center rounded-lg border border-line p-0.5">
            <button type="button" className={`h-7 rounded-md px-2 text-[12px] ${proxyType === 'socks5' ? 'bg-accent-soft text-accent' : ''}`} onClick={() => setProxyType('socks5')}>{t('host.proxySocks')}</button>
            <button type="button" className={`h-7 rounded-md px-2 text-[12px] ${proxyType === 'http' ? 'bg-accent-soft text-accent' : ''}`} onClick={() => setProxyType('http')}>{t('host.proxyHttp')}</button>
          </div>
          <Field label={t('host.port')}><TextInput value={proxyPort} onChange={(event) => setProxyPort(event.target.value)} /></Field>
          <Field label={t('host.address')}><TextInput value={proxyHost} onChange={(event) => setProxyHost(event.target.value)} /></Field>
          <Field label={t('host.user')}><TextInput value={proxyUser} onChange={(event) => setProxyUser(event.target.value)} /></Field>
          <Field label={t('host.password')}>
            <PasswordInput secretLabel={t('host.proxyPassword')} value={proxyPassword} saved={host?.proxy?.hasPassword ? { hostId: host.id, field: 'proxyPassword' } : undefined} onDraftChange={setProxyPassword} autoComplete="off" />
          </Field>
        </div>
      </Disclosure>
      <Disclosure title={t('host.jump')} hint={zh ? '经中转服务器连接内网主机。' : 'Connect through one or more jump hosts.'} open={jumps.length > 0} onToggle={(open) => setJumps(open ? [jumpDraft()] : [])}>
        <div className="space-y-3">
          {jumps.map((jump, index) => {
            const saved = host?.jumps[index]
            const matching = saved?.host === jump.host.trim() && saved.port === Number(jump.port) && saved.username === jump.username.trim()
            return <JumpCard key={jump.id} jump={jump} index={index} count={jumps.length} saved={matching && host ? { hostId: host.id, jump: saved } : undefined}
              onChange={(change) => setJumps(jumps.map((item, at) => at === index ? { ...item, ...change } : item))}
              onDelete={() => setJumps(jumps.filter((_, at) => at !== index))}
              onMove={(direction) => {
                const moved = [...jumps]
                const [item] = moved.splice(index, 1)
                moved.splice(index + direction, 0, item!)
                setJumps(moved)
              }} />
          })}
          <button type="button" disabled={jumps.length >= 5} onClick={() => setJumps([...jumps, jumpDraft()])}
            className="h-9 rounded-lg px-3 text-[13px] text-muted hover:bg-black/5 disabled:opacity-50">{t('host.addJump')}</button>
        </div>
      </Disclosure>
      <Disclosure title={t('forward.title')} hint={zh ? '通过这条 SSH 连接映射本机或远端端口。' : 'Tunnel local or remote ports over this SSH connection.'} open={forwardsOpen} onToggle={setForwardsOpen}>
        <div className="space-y-3">
          {forwards.map((rule) => <div key={rule.id} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <select aria-label={t('forward.type')} value={rule.type} className="h-9 px-2 text-[13px]" onChange={(event) => {
                const type = event.target.value as ForwardRule['type']
                updateForward(rule.id, { type, targetHost: type === 'dynamic' ? null : rule.targetHost ?? '127.0.0.1', targetPort: type === 'dynamic' ? null : rule.targetPort ?? 80 })
              }}>{(['local', 'remote', 'dynamic'] as const).map((type) => <option key={type} value={type}>{t(`forward.${type}`)}</option>)}</select>
              <button type="button" aria-label={t('forward.delete')} onClick={() => setForwards(forwards.filter((item) => item.id !== rule.id))}><Trash2 className="h-4 w-4 text-muted" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('forward.bindHost')}><TextInput value={rule.bindHost} onChange={(event) => updateForward(rule.id, { bindHost: event.target.value })} /></Field>
              <Field label={t('forward.bindPort')}><TextInput type="number" min={1} max={65535} value={rule.bindPort || ''} onChange={(event) => updateForward(rule.id, { bindPort: Number(event.target.value) })} /></Field>
              {rule.type !== 'dynamic' && <>
                <Field label={t('forward.targetHost')}><TextInput value={rule.targetHost ?? ''} onChange={(event) => updateForward(rule.id, { targetHost: event.target.value })} /></Field>
                <Field label={t('forward.targetPort')}><TextInput type="number" min={1} max={65535} value={rule.targetPort || ''} onChange={(event) => updateForward(rule.id, { targetPort: Number(event.target.value) })} /></Field>
              </>}
            </div>
            {!/^(127(?:\.\d{1,3}){3}|::1|localhost)$/i.test(rule.bindHost.trim()) && <p className="text-[12px] text-amber-600">{t('forward.exposed')}</p>}
            <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={rule.autoStart} onChange={(event) => updateForward(rule.id, { autoStart: event.target.checked })} />{t('forward.auto')}</label>
          </div>)}
          <button type="button" className="h-9 rounded-lg px-3 text-[13px] text-muted disabled:opacity-50" disabled={forwards.length >= 20} onClick={() => setForwards([...forwards, { id: crypto.randomUUID(), type: 'local', bindHost: '127.0.0.1', bindPort: 8080, targetHost: '127.0.0.1', targetPort: 80, autoStart: false }])}>{t('forward.add')}</button>
        </div>
      </Disclosure>
      <Field label={t('host.startup')}>
        <TextInput value={startup} onChange={(event) => setStartup(event.target.value)} spellCheck={false} />
      </Field>
      </div>
    </form>
  )
}

function jumpDraft(jump?: JumpPublic) {
  return {
    agentPreset: Object.entries(agentSockets).find(([, socket]) => socket === (jump?.agent?.socket ?? ''))?.[0] ?? 'custom',
    agentSocket: jump?.agent?.socket ?? '', identityFile: jump?.agent?.identityFile ?? '',
    id: crypto.randomUUID(), host: jump?.host ?? '', port: String(jump?.port ?? 22), username: jump?.username ?? 'root',
    authType: jump?.authType ?? 'password', password: '', privateKey: '', privateKeyPath: jump?.privateKeyPath ?? '', passphrase: ''
  }
}

type JumpDraft = ReturnType<typeof jumpDraft>

function JumpCard({ jump, saved, index, count, onChange, onMove, onDelete }: {
  jump: JumpDraft; saved?: { hostId: string; jump: JumpPublic }; index: number; count: number
  onChange: (change: Partial<JumpDraft>) => void; onMove: (direction: -1 | 1) => void; onDelete: () => void
}) {
  const t = useT()
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex items-center justify-between text-[12px]">
        <span>{t('host.jumpNumber', { number: index + 1 })}</span>
        <div className="flex gap-1">
          {([{ Icon: ArrowUp, label: 'host.jumpUp', disabled: index === 0, action: () => onMove(-1) },
            { Icon: ArrowDown, label: 'host.jumpDown', disabled: index === count - 1, action: () => onMove(1) },
            { Icon: Trash2, label: 'host.jumpDelete', disabled: false, action: onDelete }]).map(({ Icon, label, disabled, action }) => (
            <button key={label} type="button" title={t(label)} aria-label={t(label)} disabled={disabled} onClick={action}
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-black/5 disabled:opacity-30"><Icon size={14} strokeWidth={1.5} /></button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('host.address')}><TextInput value={jump.host} onChange={(event) => onChange({ host: event.target.value })} /></Field>
        <Field label={t('host.port')}><TextInput value={jump.port} onChange={(event) => onChange({ port: event.target.value })} /></Field>
        <Field label={t('host.user')}><TextInput value={jump.username} onChange={(event) => onChange({ username: event.target.value })} /></Field>
        <Field label={t('host.auth')}>
          <select value={jump.authType} onChange={(event) => onChange({ authType: event.target.value as AuthType })} className="h-9 w-full px-2 text-[13px]">
            <option value="password">{t('auth.password')}</option>
            <option value="privateKey">{t('auth.key')}</option>
            <option value="keyboard-interactive">{t('auth.kbd')}</option>
            <option value="agent">{t('auth.agent')}</option>
          </select>
        </Field>
        {jump.authType !== 'privateKey' && jump.authType !== 'agent' && (
          <Field label={t('host.password')}>
            <PasswordInput secretLabel={t('host.jump') + ' · ' + t('host.password')} value={jump.password} key={saved?.jump.hasPassword ? index : 'new'} saved={saved?.jump.hasPassword ? { hostId: saved.hostId, field: { jumpIndex: index, field: 'password' } } : undefined}
              onDraftChange={password => onChange({ password })} autoComplete="off" />
          </Field>
        )}
        {jump.authType === 'agent' && <div className="col-span-2 space-y-3">
          <AgentFields preset={jump.agentPreset} socket={jump.agentSocket} identity={jump.identityFile}
            onPreset={(agentPreset) => onChange({ agentPreset })} onSocket={(agentSocket) => onChange({ agentSocket })}
            onIdentity={(identityFile) => onChange({ identityFile })} />
        </div>}
        {jump.authType === 'privateKey' && (
          <>
            <Field label={t('host.keyPath')}><TextInput value={jump.privateKeyPath} onChange={(event) => onChange({ privateKeyPath: event.target.value })} /></Field>
            <Field label={t('host.key')}>
              <textarea value={jump.privateKey} onChange={(event) => onChange({ privateKey: event.target.value })} placeholder={saved?.jump.hasPrivateKey ? t('host.keep') : ''} rows={3} className="w-full px-3 py-2 font-mono text-[12px]" />
            </Field>
            <Field label={t('host.passphrase')}>
              <PasswordInput secretLabel={t('host.jump') + ' · ' + t('host.passphrase')} value={jump.passphrase} key={saved?.jump.hasPassphrase ? index : 'new'} saved={saved?.jump.hasPassphrase ? { hostId: saved.hostId, field: { jumpIndex: index, field: 'passphrase' } } : undefined}
                onDraftChange={passphrase => onChange({ passphrase })} autoComplete="off" />
            </Field>
          </>
        )}
      </div>
    </div>
  )
}

function Disclosure({
  title,
  hint,
  open,
  onToggle,
  children
}: {
  title: string
  hint?: string
  open: boolean
  onToggle: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="rounded-xl border border-line">
      <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-[13px]" onClick={() => onToggle(!open)}>
        <span className="min-w-0 text-left"><span className="block">{title}</span>{hint && <span className="mt-0.5 block text-[12px] leading-5 text-muted">{hint}</span>}</span>
        <span className="ml-3 shrink-0 text-muted">{open ? '–' : '+'}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

function AgentFields({ preset, socket, identity, onPreset, onSocket, onIdentity }: {
  preset: string; socket: string; identity: string
  onPreset: (value: string) => void; onSocket: (value: string) => void; onIdentity: (value: string) => void
}) {
  const t = useT()
  const win = api().platform === 'win32'
  const mac = api().platform === 'darwin'
  return <>
    <Field label={t('host.agent')}>
      <select value={preset} onChange={(event) => onPreset(event.target.value)} className="h-9 w-full px-2 text-[13px]">
        <option value="system">{t(win ? 'agent.systemWin' : 'agent.system')}</option>
        {(win || preset === 'pageant') && <option value="pageant">{t('agent.pageant')}</option>}
        {(mac || preset === 'onePassword') && <option value="onePassword">1Password</option>}
        {(mac || preset === 'secretive') && <option value="secretive">Secretive</option>}
        <option value="custom">{t('agent.custom')}</option>
      </select>
    </Field>
    {preset === 'custom' && (
      <Field label={t('agent.socket')}><TextInput value={socket} onChange={(event) => onSocket(event.target.value)} placeholder={win ? '\\\\.\\pipe\\openssh-ssh-agent' : ''} spellCheck={false} /></Field>
    )}
    <Field label={t('agent.identity')}>
      <TextInput value={identity} onChange={(event) => onIdentity(event.target.value)} placeholder={win ? '~\\.ssh\\id_ed25519.pub' : '~/.ssh/id_ed25519.pub'} spellCheck={false} />
    </Field>
  </>
}
