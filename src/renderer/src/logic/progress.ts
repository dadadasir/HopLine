export interface TaskProgress { state: 1 | 2 | 3 | 4; value: number; updatedAt: number }

export function parseProgress(text: string, now: number): TaskProgress | null | undefined {
  const match = /^4;([0-4])(?:;(\d{1,3}))?$/.exec(text)
  if (!match) return undefined
  const state = Number(match[1])
  if (state === 0) return null
  if ((state === 1 || state === 2 || state === 4) && match[2] === undefined) return undefined
  return { state: state as TaskProgress['state'], value: Math.min(100, Number(match[2] ?? 0)), updatedAt: now }
}
export function visibleProgress(progress?: TaskProgress | null, now = Date.now()): TaskProgress | null {
  return progress && now - progress.updatedAt < 30_000 ? progress : null
}
