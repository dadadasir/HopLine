import type { TaskNotification } from '../../../shared/types'
import { cleanNotificationText } from '../logic/notify'
import { parseProgress, type TaskProgress } from '../logic/progress'
import type { Terminal } from '@xterm/xterm'

// One limiter per session, shared by OSC notifications and BEL.
export class NotificationLimiter {
  private lastAt: number | undefined

  accept(now: number): boolean {
    if (this.lastAt !== undefined && now - this.lastAt < 10_000) return false
    this.lastAt = now
    return true
  }
}

export function installOscPolicy(
  term: Pick<Terminal, 'parser' | 'options' | 'onBell'>,
  deps: { openExternal: (uri: string) => Promise<void>; now?: () => number;
    sessionId?: string; title?: () => string; isBackground?: () => boolean
    onNotify?: (sessionId: string, message: TaskNotification) => void
    onProgress?: (progress: TaskProgress | null) => void; onTitle?: (title: string) => void }
): () => void {
  const limiter = new NotificationLimiter()
  const notify = (title: string, body: string) => {
    if (limiter.accept((deps.now ?? Date.now)())) deps.onNotify?.(deps.sessionId ?? '', {
      title: cleanNotificationText(title, 64), body: cleanNotificationText(body, 256)
    })
  }
  const previous = term.options.linkHandler
  term.options.linkHandler = {
    activate(event, uri) {
      event.preventDefault()
      try {
        const protocol = new URL(uri).protocol
        if (protocol === 'http:' || protocol === 'https:') void deps.openExternal(uri).catch(() => undefined)
      } catch {
        // Malformed links are ignored just like unsupported protocols.
      }
    }
  }
  const handlers = [
    term.parser.registerOscHandler(52, () => true),
    term.parser.registerOscHandler(9, (text) => {
      if (text === '4' || text.startsWith('4;')) {
        const progress = parseProgress(text, (deps.now ?? Date.now)())
        if (progress !== undefined) deps.onProgress?.(progress)
      } else notify(deps.title?.() ?? 'HopLine', text)
      return true
    }),
    term.parser.registerOscHandler(777, (text) => {
      const [kind, title, ...body] = text.split(';')
      if (kind === 'notify') notify(title ?? '', body.join(';'))
      return true
    }),
    ...[0, 2].map((code) => term.parser.registerOscHandler(code, (title) => {
      deps.onTitle?.(cleanNotificationText(title, 256)); return true
    })),
    term.onBell(() => { if (deps.isBackground?.() ?? true) notify(deps.title?.() ?? 'HopLine', '') })
  ]
  return () => {
    handlers.forEach((handler) => handler.dispose())
    term.options.linkHandler = previous
  }
}
