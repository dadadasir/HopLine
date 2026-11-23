import type { CleanupChange, CleanupEstimate } from '../../../core/runbook/cleanup'
import { cleanupDefaults } from '../../../core/runbook/cleanup'
import { formatCell } from './overview'
import type { RunbookPreview } from '@shared/types'
import type { StepResult } from '../../../core/runbook/types'
export const cleanupSelection = (plan: RunbookPreview): string[] => cleanupDefaults.filter((id) => plan.steps.some((step) => step.id === id && step.status === 'needed') && plan.cleanup?.[id]?.bytes != null && !plan.cleanup[id].unavailable)
export const cleanupTotal = (selected: string[], estimates: Record<string, CleanupEstimate> = {}): number => [...new Set(selected)].reduce((sum, id) => sum + (estimates[id]?.bytes ?? 0), 0)
export const cleanupReleased = (changes: Record<string, CleanupChange>): number => Object.values(changes).reduce((sum, { before, after }) => sum + (before !== null && after !== null ? Math.max(0, before - after) : 0), 0)
export const cleanupSize = (bytes: number): string => formatCell('sizeBytes', bytes, 'zh')
export const cleanupGroups = ['docker', 'logs', 'packages', 'system'] as const
export const cleanupGroup = (id: string): typeof cleanupGroups[number] => id.startsWith('docker-') ? 'docker' : ['journal', 'rotated-logs'].includes(id) ? 'logs' : ['apt-cache', 'dnf-cache', 'apk-cache'].includes(id) ? 'packages' : 'system'
/** The IPC output is complete rows of KiB + path, already capped; reject malformed sizes rather than guessing. */
export function cleanupDirectories(output: string): { path: string; bytes: number }[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^(\d+)[ \t]+(\/[^\0\r\n]*)$/.exec(line)
    const bytes = match ? Number(match[1]) * 1024 : NaN
    return match && Number.isSafeInteger(bytes) ? [{ path: match[2], bytes }] : []
  }).sort((a, b) => b.bytes - a.bytes)
}
export const cleanupActual = (change?: CleanupChange): number | null => change?.before != null && change.after != null ? Math.max(0, change.before - change.after) : null

/** Presentation filters only. The runbook remains responsible for execution eligibility. */
export const cleanupSelectable = (plan: RunbookPreview): string[] => plan.steps.filter(step => step.status === 'needed' && !plan.cleanup?.[step.id]?.unavailable && plan.cleanup?.[step.id]?.bytes != null && plan.cleanup[step.id].bytes! > 0).map(step => step.id)
export const cleanupEmpty = (plan: RunbookPreview, id: string): boolean => !!plan.cleanup?.[id]?.unavailable || plan.steps.find(step => step.id === id)?.status === 'already' || plan.cleanup?.[id]?.bytes === 0
export function cleanupIncompleteReason(result?: StepResult): string {
  if (!result) return 'cleanup.ui.reason.noResult'
  if (result.reason.includes('已取消')) return 'cleanup.ui.reason.stopped'
  if (result.reason.includes('前序步骤失败')) return 'cleanup.ui.reason.previous'
  if (result.reason.includes('验证失败')) return 'cleanup.ui.reason.verify'
  if (result.reason.includes('root') || result.reason.includes('sudo')) return 'cleanup.ui.reason.permission'
  if (result.status === 'unavailable') return 'cleanup.ui.reason.changed'
  if (result.status === 'skipped') return 'cleanup.ui.reason.uncertain'
  return 'cleanup.ui.reason.failed'
}
