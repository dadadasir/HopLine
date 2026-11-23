import { useEffect, useState } from 'react'
import { api, errorText, useAppSelector } from '../state'
import { queueUnlock } from '../state/tabs'
import { isLockedError } from '../logic/locked-error'
import { SftpPanel } from './SftpPanel'
import { QuietButton } from './ui'

export function HostFiles({ hostId, fullWidth = true, terminalSessionId }: { hostId: string; fullWidth?: boolean; terminalSessionId?: string }) {
  const host = useAppSelector(s => s.hosts.find(host => host.id === hostId))
  const [connection, setConnection] = useState<{ id: string; revision: string } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const en = useAppSelector(s => s.settings?.language === 'en')
  const revision = `${hostId}:${host?.updatedAt ?? 0}:${attempt}`
  useEffect(() => {
    let active = true
    setError('')
    const open = async () => {
      if (!active) return
      try {
        const id = await api().sftp.openHost(hostId)
        if (active) { setError(''); setConnection({ id, revision }) }
      } catch (err) {
        if (!active) return
        setError(errorText(err))
        if (isLockedError(err)) queueUnlock(`files:${hostId}`, open)
      }
    }
    void open()
    return () => { active = false }
  }, [hostId, revision])
  if (connection?.revision === revision) return <div className="flex min-h-0 min-w-0 flex-1 flex-col"><div className="border-b border-line px-3 py-2 text-[11px] text-muted" title={host ? `${host.username}@${host.host}:${host.port}` : hostId}>{host?.name} · {host?.host}:{host?.port}</div><SftpPanel key={connection.id} sessionId={connection.id} fullWidth={fullWidth} integrationSessionId={terminalSessionId} /></div>
  return <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 p-6 text-[13px]">
    {error ? <><p role="alert" className="max-w-lg break-words text-red-600 dark:text-red-300">{error}</p><QuietButton onClick={() => setAttempt(attempt + 1)}>{en ? 'Retry connection' : '重新连接'}</QuietButton></> : <p role="status" className="text-muted">{en ? 'Connecting files… Complete any authentication prompt to continue.' : '正在连接文件服务… 如有认证提示，请完成解锁或指纹确认。'}</p>}
  </div>
}
