import { useEffect, useState, type ReactNode } from 'react'
import { api, connectHost, errorText, openHost, patch, refreshHost, shallowEqual, toast, useAppSelector } from '../state'
import { openSecurity } from '../state/security'
import { finishOnboarding, onboardingStep, readOnboardingDone, readOnboardingProgress, saveOnboardingProgress } from '../logic/onboarding'
import { PrimaryButton, QuietButton, useT } from './ui'

export function Onboarding({ children }: { children: ReactNode }) {
  const state = useAppSelector(s => ({
    hosts: s.hosts, tabs: s.tabs, connecting: s.connecting, route: s.route, records: s.snapshots, settingsOpen: s.settingsOpen
  }), shallowEqual)
  const [connectedHost, setConnectedHost] = useState(() => readOnboardingProgress() || null)
  const [done, setDone] = useState(() => readOnboardingDone() || (state.hosts.length > 0 && readOnboardingProgress() === null))
  const [busy, setBusy] = useState(false)
  const host = state.hosts.find(item => item.id === connectedHost) ?? state.hosts[0]
  const connected = Boolean(host && host.id === connectedHost)
  const step = onboardingStep(done, !!host, connected)
  const visible = !state.settingsOpen && (state.route.page === 'overview' || (
    connected && state.route.page === 'host' && state.route.hostId === connectedHost
  ))
  const t = useT()
  const finish = () => { finishOnboarding(); setDone(true) }

  useEffect(() => {
    if (done || connected || state.connecting) return
    if (host) saveOnboardingProgress()
    const first = state.tabs.find(tab => tab.kind === 'ssh' && tab.status === 'connected' && tab.hostId && state.hosts.some(item => item.id === tab.hostId))
    if (!first?.hostId) return
    saveOnboardingProgress(first.hostId)
    setConnectedHost(first.hostId)
    void refreshHost(first.hostId, true)
    if (state.route.page === 'sessions') openHost(first.hostId)
  }, [done, connected, host, state.hosts, state.tabs, state.route, state.connecting])

  const securityScore = host ? state.records[host.id]?.securityScore : undefined
  useEffect(() => { if (!done && connected && securityScore !== undefined) finish() }, [done, connected, securityScore])

  const check = async () => {
    if (!host || busy) return
    setBusy(true)
    try { await api().security.check(host.id); finish(); openSecurity(host.id) }
    catch (error) { toast(t(errorText(error)), 'err') }
    finally { setBusy(false) }
  }

  return <div className="flex min-h-0 flex-1 flex-col overflow-auto">
    {step && visible && <section data-onboarding-step={step} aria-label={t('onboarding.title')} className="m-3 rounded-2xl border border-line bg-panel p-5">
      <h1 className="mb-3 text-base font-semibold">{step === 3 ? t('onboarding.connected', { name: host!.name }) : t('onboarding.title')}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {step === 1 && <>
          <PrimaryButton onClick={() => patch({ hostDialog: 'recognize' })}>{t('onboarding.paste')}</PrimaryButton>
          <QuietButton onClick={() => patch({ hostDialog: 'new' })}>{t('onboarding.manual')}</QuietButton>
          <QuietButton onClick={() => patch({ importSshConfigOpen: true })}>{t('onboarding.import')}</QuietButton>
        </>}
        {step === 2 && <PrimaryButton disabled={!!state.connecting} onClick={() => { if (host) void connectHost(host) }}>{t('onboarding.connectHost', { name: host!.name })}</PrimaryButton>}
        {step === 3 && <PrimaryButton disabled={busy} onClick={() => void check()}>{t(busy ? 'runbook.checking' : 'onboarding.run')}</PrimaryButton>}
        <QuietButton onClick={finish}>{t('onboarding.skip')}</QuietButton>
      </div>
    </section>}
    <div className="flex min-h-0 flex-1 flex-col" style={{ display: step === 1 && visible ? 'none' : undefined }}>{children}</div>
  </div>
}
