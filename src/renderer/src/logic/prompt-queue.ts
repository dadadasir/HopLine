/** Ignore redelivered events, keeping the original prompt and FIFO order. */
export function enqueuePrompt<T extends { requestId: string }>(queue: readonly T[], prompt: T): T[] {
  return queue.some((item) => item.requestId === prompt.requestId) ? [...queue] : [...queue, prompt]
}

/** A stale/double response must never dismiss the next connection's prompt. */
export function dequeuePrompt<T extends { requestId: string }>(queue: readonly T[], requestId: string): T[] {
  return queue[0]?.requestId === requestId ? queue.slice(1) : [...queue]
}

/** Expiration can remove a queued prompt as well as the visible one. */
export function expirePrompt<T extends { requestId: string }>(queue: readonly T[], requestId: string): T[] {
  return queue.filter((item) => item.requestId !== requestId)
}
