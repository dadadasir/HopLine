import { useSyncExternalStore } from 'react'
import { shellMarks, subscribeShellMarks } from '../terminal/marks'

export function useShellIntegration(id: string | null) {
  const active = useSyncExternalStore(subscribeShellMarks, () => id ? shellMarks.get(id)?.active ?? false : false)
  const cwd = useSyncExternalStore(subscribeShellMarks, () => id ? shellMarks.get(id)?.cwd : undefined)
  return { active, cwd }
}
