import { Notification, type BrowserWindow } from 'electron'
import type { SessionInfo, TaskNotification } from '../shared/types'
import { cleanNotificationText, shouldNotify } from '../renderer/src/logic/notify'
import { NotificationLimiter } from '../renderer/src/terminal/osc'

export function createNotifier(getWindow: () => BrowserWindow | null, sessions: () => SessionInfo[]) {
  const limiters = new Map<string, NotificationLimiter>()
  return (sessionId: string, message: TaskNotification, activeId: string | null, enabled: boolean): boolean => {
    const win = getWindow(), live = sessions()
    for (const id of limiters.keys()) if (!live.some((session) => session.id === id)) limiters.delete(id)
    if (!win || win.isDestroyed() || !live.some((session) => session.id === sessionId) ||
      !shouldNotify(enabled === true, sessionId === activeId, win.isFocused())) return false
    const limiter = limiters.get(sessionId) ?? new NotificationLimiter()
    limiters.set(sessionId, limiter)
    if (!limiter.accept(Date.now())) return false
    if (Notification.isSupported()) {
      const notification = new Notification({ title: cleanNotificationText(message.title, 64), body: cleanNotificationText(message.body, 256) })
      notification.on('click', () => {
        if (win.isDestroyed() || !sessions().some((session) => session.id === sessionId)) return
        if (win.isMinimized()) win.restore()
        win.show(); win.focus()
        win.webContents.send('notify:activate', sessionId)
      })
      notification.show()
    }
    return true
  }
}
