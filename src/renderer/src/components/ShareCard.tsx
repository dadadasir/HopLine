import type { SecurityReport } from '@shared/types'
import { shareData, shareHTML } from '../../../core/security/share'
import { useT } from './ui'
export function ShareCard({ report, host }: { report: SecurityReport; host?: string }) {
  const t = useT()
  return <iframe title={t('security.share')} sandbox="" srcDoc={shareHTML(shareData(report, host), t)} className="block w-full border-0" style={{ aspectRatio: '1200 / 630' }} />
}
