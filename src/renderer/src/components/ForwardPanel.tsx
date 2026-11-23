import { patch, toggleForward, useAppSelector } from '../state'
import { forwardLabel } from '../logic/palette'
import { Modal, QuietButton, useT } from './ui'

export function ForwardPanel() {
  const open = useAppSelector((state) => state.forwardsOpen), hosts = useAppSelector((state) => state.hosts)
  const statuses = useAppSelector((state) => state.forwards), t = useT()
  return <Modal open={open} title={t('forward.view')} onClose={() => patch({ forwardsOpen: false })} width="w-[620px]">
    <div className="space-y-3">
      {!hosts.some((host) => host.forwards.length) && <p className="text-sm text-muted">{t('forward.empty')}</p>}
      {hosts.flatMap((host) => host.forwards.map((rule) => {
        const status = statuses.find((item) => item.hostId === host.id && item.ruleId === rule.id), running = status?.state === 'running'
        return <div key={`${host.id}:${rule.id}`} className="rounded-lg border border-line p-3 text-[13px]">
          <div className="flex items-center justify-between gap-3"><span className="break-all">{host.name} {forwardLabel(rule)}</span>
            <QuietButton onClick={() => void toggleForward(host.id, rule.id, running)}>{t(running ? 'forward.stop' : 'forward.start')}</QuietButton></div>
          <p className="text-muted">{t(`forward.${status?.state ?? 'stopped'}`)} · {t('forward.connections', { count: status?.connections ?? 0 })}</p>
          {status?.error && <p className="text-red-600">{status.error}</p>}
        </div>
      }))}
    </div>
  </Modal>
}
