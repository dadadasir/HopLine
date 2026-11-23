import { HostSecrets, CONCEALED_FORMAT, OWNER_FORMAT } from './host-secrets'
import { DEFAULT_FX } from '../core/fx-defaults'
import type { FxService } from './fx-service'
import { createNotifier } from './notify'
import type { PersistentOptions, TaskNotification } from '../shared/types'
import { createDiagnostics } from './diagnostics'
import { listInitIdentities, loginAsNewUser, validateInitAuth } from './init-gates'
import { KnownHostFile } from './known-hosts-file'
import type { InitAuth } from '../shared/types'
import type { SecurityService } from './security-service'
import { shareData, shareHTML } from '../core/security/share'
import { translate } from '../renderer/src/i18n'
import type { ForwardManager } from './forwarding'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSshConfig, markSshConfigDuplicates, type SshConfigReader } from '../core/ssh-config'
import type { CollectService } from './collect-service'
import type { RunbookService } from './runbook-service'
import { BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { BackupService } from './backup/service'
import type { SessionHub } from './sessions'
import type { Vault } from '../core/vault'
import type { AppInfo, HostInput, SettingsPatch } from '../shared/types'
import { listSnippets, saveSnippet, deleteSnippet } from './snippets'
import type { SnippetInput } from '../shared/types'
import { createSafeCodec, KeystoreReadError, safeStorageAvailable, setSecretKeyProvider } from './secrets'
import { ShellIntegrationStore } from './shell-integration-store'
import { logError } from './logger'
import type { UpdateService } from './update-service'
import { isReleaseUrl } from '../core/updates'
import { getMainCapabilities } from './ext/capabilities'

const EVENTS = new Set([
  'app:capabilities',
  'updates:available',
  'fx:updated',
  'hosts:clearRevealed',
  'runbook:progress',
  'collect:updated',
  'forwards:status',
  'ssh:data',
  'ssh:status',
  'pty:data',
  'pty:exit',
  'hostkey:prompt',
  'kbd:prompt',
  'transfer:event',
  'theme:changed',
  'store:changed',
  'menu:command',
  'edit:synced',
  'pro:event',
  'notify:activate',
  'watchdog:ping',
  'window:maximized'
])

export interface IpcDeps {
  fx?: FxService
  updates?: UpdateService
  versionChange?: import('../shared/api').VersionChange | null
  security?: SecurityService
  runbook?: RunbookService
  collect?: CollectService
  forwards?: ForwardManager
  vault: Vault
  save: () => void
  sessions: SessionHub
  backup: BackupService
  getWindow: () => BrowserWindow | null
  shots: boolean
  version: string
  userData: string
  dataNotices?: AppInfo['dataNotices']
  keystoreReadFailed?: boolean
  onRelaunch?: () => void
  onLanguage?: (language: 'zh' | 'en') => void
  onChanged?: () => void
  onTheme: (theme: 'system' | 'light' | 'dark') => void
  resolvedTheme: () => 'light' | 'dark'
  watchdogPong?: (id: number) => void
}

export function makeCallerGuard(getWindow: IpcDeps['getWindow']) {
  return (event: IpcMainInvokeEvent | IpcMainEvent) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents) throw new Error('拒绝的调用方')
  }
}

export function registerIpc(deps: IpcDeps): () => Promise<void> {
  if (deps.backup?.onUnlocked) {
    setSecretKeyProvider(() => deps.backup.secretKey())
    const migrateSecrets = () => !deps.keystoreReadFailed && deps.vault.reencryptSecrets((value) => value.startsWith('plain:'), createSafeCodec())
    deps.backup.onUnlocked(migrateSecrets)
    if (deps.backup.status().unlocked && migrateSecrets()) deps.save()
  }
  const guard = makeCallerGuard(deps.getWindow)
  ipcMain.handle('app:capabilities', (event) => { guard(event); return getMainCapabilities() })
  ipcMain.handle('fx:read', event => { guard(event); return deps.fx?.read() ?? structuredClone(DEFAULT_FX) })
  ipcMain.handle('updates:preferences', (event) => { guard(event); return deps.updates!.preferences() })
  ipcMain.handle('updates:setAutomatic', (event, enabled: boolean) => {
    guard(event)
    if (typeof enabled !== 'boolean') throw new Error('更新检查设置不合法')
    return deps.updates!.setAutomatic(enabled)
  })
  ipcMain.handle('updates:check', (event) => { guard(event); return deps.updates!.check(true) })
  ipcMain.handle('updates:openRelease', async (event, url: string) => {
    guard(event)
    if (typeof url !== 'string' || !isReleaseUrl(url)) throw new Error('更新页面链接不合法')
    await shell.openExternal(url)
  })
  const shellIntegration = deps.userData ? new ShellIntegrationStore(deps.userData) : undefined
  shellIntegration?.prune((id) => !!deps.vault.getHost(id))
  if (deps.runbook) deps.runbook.shellIntegrationChanged = (id, installed) => shellIntegration?.set(id, installed)
  let versionChange = deps.versionChange ?? null
  ipcMain.handle('app:versionChange', (event) => {
    guard(event)
    const change = versionChange
    versionChange = null
    return change
  })
  const notify = createNotifier(deps.getWindow, () => deps.sessions.list())
  ipcMain.handle('notify:task', (event, id: string, message: TaskNotification, activeId: string | null, enabled: boolean) => {
    guard(event)
    if (typeof message?.title !== 'string' || typeof message?.body !== 'string') throw new Error('通知不合法')
    return notify(requireString(id), message, activeId, enabled)
  })
  ipcMain.handle('persistent:list', (event, hostId: string) => { guard(event); return deps.sessions.listPersistent(requireString(hostId)) })
  ipcMain.handle('persistent:kill', async (event, hostId: string, name: string) => {
    guard(event)
    const host = deps.vault.getHost(requireString(hostId))
    if (!host) throw new Error('主机不存在')
    const t = (key: string) => translate(deps.vault.snapshot().settings.language, key)
    const answer = await dialog.showMessageBox(deps.getWindow()!, { type: 'warning', buttons: [t('confirm.cancel'), t('persistent.kill')], defaultId: 0, cancelId: 0,
      message: t('persistent.kill'), detail: `${host.name}: ${requireString(name)}` })
    if (answer.response === 1) await deps.sessions.killPersistent(hostId, name)
  })
  const diagnostics = createDiagnostics(deps.vault, deps.sessions, deps.userData, deps.getWindow)
  ipcMain.handle('diagnostics:preview', (event) => { guard(event); return diagnostics.preview() })
  ipcMain.handle('diagnostics:save', (event, preview: string) => { guard(event); return diagnostics.save(preview) })
  ipcMain.handle('watchdog:sessions', (event) => { guard(event); return deps.sessions.list() })
  ipcMain.on('watchdog:pong', (event, id: number) => {
    try { guard(event) } catch { return }
    if (typeof id === 'number') deps.watchdogPong?.(id)
  })
  ipcMain.handle('cleanup:disk', (event, hostId: string, mount: string) => {
    guard(event)
    const id = requireString(hostId)
    if (!deps.vault.getHost(id)) throw new Error('主机不存在')
    return deps.runbook!.disk(id, requireString(mount))
  })
  ipcMain.handle('cleanup:du', async (event, hostId: string, mount: string, requestId?: string) => {
    guard(event)
    const id = requireString(hostId)
    if (!deps.vault.getHost(id)) throw new Error('主机不存在')
    if (requestId !== undefined) requireString(requestId)
    return deps.runbook!.directory(id, requireString(mount), requestId)
  })
  ipcMain.handle('cleanup:diagnose', (event, hostId: string, password?: string, requestId?: string) => {
    guard(event)
    if (password !== undefined && typeof password !== 'string') throw new Error('剧本参数不合法')
    if (requestId !== undefined) requireString(requestId)
    return requestId === undefined ? deps.runbook!.diagnose(requireString(hostId), password) : deps.runbook!.diagnose(requireString(hostId), password, requestId)
  })
  ipcMain.handle('cleanup:sudo', (event, hostId: string, requestId?: string) => {
    guard(event)
    if (requestId !== undefined) requireString(requestId)
    return requestId === undefined ? deps.runbook!.sudo(requireString(hostId)) : deps.runbook!.sudo(requireString(hostId), requestId)
  })
  ipcMain.handle('init:identities', (event) => { guard(event); return listInitIdentities() })
  ipcMain.handle('init:plan', (event, hostId: string, params: Record<string, string>, auth: InitAuth) => {
    guard(event); validateInitAuth(auth)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.values(params).some((value) => typeof value !== 'string')) throw new Error('剧本参数不合法')
    const id = requireString(hostId), chosen = { ...auth }
    return deps.runbook!.plan(id, 'init', params, { 'login-as-new-user': (values) => loginAsNewUser(deps.vault, id, chosen, values, async (check) => {
      const known = new KnownHostFile(path.join(deps.userData, 'known_hosts.json')); known.load()
      return known.judge(check.host, check.port, check.fingerprint) === 'trusted'
    }) })
  })
  ipcMain.handle('runbook:plan', (event, hostId: string, bookId: string, params: Record<string, string>, password?: string, requestId?: string) => {
    guard(event)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.values(params).some((value) => typeof value !== 'string')) throw new Error('剧本参数不合法')
    if (password !== undefined && typeof password !== 'string') throw new Error('剧本参数不合法')
    if (requestId !== undefined) {
      requireString(requestId)
      if (bookId !== 'cleanup') throw new Error('剧本参数不合法')
      return deps.runbook!.plan(requireString(hostId), bookId, params, {}, password, requestId)
    }
    return password === undefined ? deps.runbook!.plan(requireString(hostId), requireString(bookId), params)
      : deps.runbook!.plan(requireString(hostId), requireString(bookId), params, {}, password)
  })
  ipcMain.handle('runbook:run', (event, hostId: string, planId: string, selected: string[], password?: string) => {
    guard(event)
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string') || (password !== undefined && typeof password !== 'string')) throw new Error('剧本参数不合法')
    return deps.runbook!.run(requireString(hostId), requireString(planId), selected, password)
  })
  ipcMain.handle('runbook:cancel', (event, hostId: string, planId?: string) => {
    guard(event)
    if (planId === undefined) deps.runbook!.cancel(requireString(hostId))
    else deps.runbook!.cancel(requireString(hostId), requireString(planId))
  })
  ipcMain.handle('oplog:list', (event, hostId: string) => { guard(event); return deps.runbook!.log.list(requireString(hostId)) })
  ipcMain.handle('security:check', (event, id: string, options?: { sudoPassword?: string }) => {
    guard(event)
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'sudoPassword'))) throw new Error('security.invalid')
    return deps.security!.check(requireString(id), options)
  })
  ipcMain.handle('security:latest', (event, id: string) => { guard(event); return deps.security!.latest(requireString(id)) })
  ipcMain.handle('security:ignore', (event, id: string, rule: string, note: string) => { guard(event); if (typeof note !== 'string') throw new Error('security.invalid'); return deps.security!.ignore(requireString(id), requireString(rule), note) })
  ipcMain.handle('security:unignore', (event, id: string, rule: string) => { guard(event); return deps.security!.ignore(requireString(id), requireString(rule), null) })
  ipcMain.handle('security:share', async (event, id: string, options?: { host?: boolean }) => {
    guard(event)
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'host') || (options.host !== undefined && typeof options.host !== 'boolean'))) throw new Error('security.invalid')
    const shownHost = options?.host === true ? deps.vault.getHost(requireString(id))?.host : undefined
    const report = deps.security!.latest(requireString(id)), parent = deps.getWindow()!
    if (!report) throw new Error('security.invalid')
    const { filePath, canceled } = await dialog.showSaveDialog(parent, { defaultPath: 'hopline-security.png', filters: [{ name: 'PNG', extensions: ['png'] }] })
    if (canceled || !filePath) return null
    const card = new BrowserWindow({ show: false, width: 1200, height: 630, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
    try {
      const locale = deps.vault.snapshot().settings.language
      await card.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(shareHTML(shareData(report, shownHost), (key) => translate(locale, key)))}`)
      await card.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
      const image = (await card.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 630 })).resize({ width: 1200, height: 630 })
      fs.writeFileSync(filePath, image.toPNG(), { mode: 0o600 }); await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
      return filePath
    } finally { card.destroy() }
  })
  // A committed catalog write must not look like a failed save because an
  // unrelated cache or notification failed: retrying could create duplicates.
  const afterSaved = (action: () => unknown) => {
    try { void Promise.resolve(action()).catch((error: unknown) => logError('已保存主机库，附属状态更新失败', error)) }
    catch (error) { logError('已保存主机库，附属状态更新失败', error) }
  }
  const changed = (alreadySaved = false) => {
    if (!alreadySaved) deps.save()
    afterSaved(() => deps.onChanged?.())
    afterSaved(() => deps.forwards?.reconcile())
    afterSaved(() => deps.collect?.prune())
    afterSaved(() => deps.runbook?.prune())
    afterSaved(() => shellIntegration?.prune((id) => !!deps.vault.getHost(id)))
    afterSaved(() => deps.security?.prune())
    afterSaved(() => deps.backup.scheduleAuto())
    afterSaved(() => deps.getWindow()?.webContents.send('store:changed'))
  }
  const restored = () => {
    // A restore awaits I/O and decryption. A host could change A→C→A while
    // waiting, so an earlier fingerprint cannot identify the cached observation.
    // All restored observations need a fresh collection, without starting one.
    afterSaved(() => {
      if (deps.collect?.invalidate) for (const host of deps.vault.listHosts()) afterSaved(() => deps.collect!.invalidate(host.id))
    })
    afterSaved(() => deps.collect?.prune())
    afterSaved(() => deps.forwards?.reconcile())
    afterSaved(() => deps.runbook?.prune())
    afterSaved(() => shellIntegration?.prune((id) => !!deps.vault.getHost(id)))
    afterSaved(() => deps.security?.prune())
    afterSaved(() => deps.sessions.pool.invalidateAll())
    afterSaved(() => deps.onChanged?.())
    afterSaved(() => deps.onLanguage?.(deps.vault.snapshot().settings.language))
    afterSaved(() => deps.getWindow()?.webContents.send('store:changed'))
  }

  ipcMain.handle('collect:run', (event, hostId: string, authenticated?: boolean) => {
    guard(event)
    const id = requireString(hostId)
    return authenticated === true ? deps.collect!.runConnected(id) : deps.collect!.run(id)
  })
  ipcMain.handle('collect:latest', (event) => { guard(event); return deps.collect!.latest() })
  ipcMain.handle('collect:overview', (event, open: boolean) => {
    guard(event)
    if (typeof open !== 'boolean') throw new Error('参数不完整')
    deps.collect!.setOverviewOpen(open)
  })
  ipcMain.handle('forwards:list', (event) => { guard(event); return deps.forwards!.statuses() })
  ipcMain.handle('forwards:start', (event, hostId: string, ruleId: string) => { guard(event); return deps.forwards!.start(requireString(hostId), requireString(ruleId)) })
  ipcMain.handle('forwards:stop', (event, hostId: string, ruleId: string) => { guard(event); return deps.forwards!.stop(requireString(hostId), requireString(ruleId)) })

  ipcMain.handle('snippets:list', (event) => {
    guard(event)
    return listSnippets()
  })
  ipcMain.handle('snippets:save', (event, input: SnippetInput) => {
    guard(event)
    return saveSnippet(input)
  })
  ipcMain.handle('snippets:delete', (event, id: string) => {
    guard(event)
    deleteSnippet(id)
  })

  ipcMain.handle('hosts:importSshConfig:preview', (event) => {
    guard(event)
    const readFile: SshConfigReader = (file) => {
      try { return fs.readFileSync(file, 'utf8') } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
        throw error
      }
    }
    readFile.glob = (pattern) => fs.globSync(process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern)
    return markSshConfigDuplicates(parseSshConfig(path.join(os.homedir(), '.ssh', 'config'), readFile, os.homedir()), deps.vault.listHosts())
  })
  ipcMain.handle('hosts:importSshConfig:apply', (event, hosts: HostInput[], groupId: string | null) => {
    guard(event)
    if (!Array.isArray(hosts) || (groupId !== null && typeof groupId !== 'string')) throw new Error('导入参数不正确')
    let success = 0, failed = 0
    for (const host of hosts) {
      try {
        deps.vault.saveHost({ ...host, id: undefined, groupId })
        success++
      } catch { failed++ }
    }
    if (success) changed()
    return { success, failed }
  })
  const hostSecrets = new HostSecrets({
    vault: deps.vault,
    checkKeystore: payload => {
      if (payload?.startsWith('safe:') && (deps.keystoreReadFailed || !safeStorageAvailable())) {
        throw new KeystoreReadError(deps.vault.settingsPublic(false).language)
      }
    },
    locked: () => { const settings = deps.vault.settingsPublic(deps.backup.status().unlocked); return settings.backup.hasPassword && !settings.backup.unlocked },
    canPromptTouchID: () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
    promptTouchID: reason => systemPreferences.promptTouchID(reason),
    clipboard: {
      write: async (text, token) => {
        await clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }),
          [CONCEALED_FORMAT]: new Blob(['']), [OWNER_FORMAT]: new Blob([token]) })])
      },
      matches: async (text, token) => {
        const items = await clipboard.read()
        const item = items.find(value => value.types.includes(OWNER_FORMAT))
        return !!item && await (await item.getType(OWNER_FORMAT)).text() === token && await clipboard.readText() === text
      },
      clear: () => clipboard.clear()
    }
  })
  ipcMain.handle('hosts:copyConnectionCard', (event, id: unknown) => { guard(event); return hostSecrets.copyConnectionCard(id, () => guard(event)) })
  ipcMain.handle('hosts:copySecret', (event, id: unknown, field: unknown) => { guard(event); return hostSecrets.copy(id, field, () => guard(event)) })
  ipcMain.handle('hosts:revealSecret', (event, id: unknown, field: unknown) => { guard(event); return hostSecrets.reveal(id, field, () => guard(event)) })
  ipcMain.handle('hosts:list', (event) => {
    guard(event)
    return deps.vault.listHosts()
  })
  ipcMain.handle('hosts:save', (event, input: HostInput) => {
    guard(event)
    // Check before saveHost mutates an existing record's non-secret fields.
    if (!safeStorageAvailable()) {
      const entries = [input, input?.proxy, ...(Array.isArray(input?.jumps) ? input.jumps : [])]
      if (entries.some((entry) => entry && ['password', 'privateKey', 'passphrase'].some((field) => {
        const value = (entry as unknown as Record<string, unknown>)[field]
        return typeof value === 'string' && value.length > 0
      }))) createSafeCodec().encrypt('')
    }
    const integrationHost = input?.id && shellIntegration?.has(input.id) ? deps.vault.getHost(input.id) : undefined
    const integrationEndpoint = integrationHost && JSON.stringify([integrationHost.host, integrationHost.port, integrationHost.username])
    const previousTarget = input?.id && deps.vault.getHost(input.id) ? deps.sessions.pool.connectionTarget?.(input.id) : undefined
    const saved = deps.vault.saveHostWithGroup(input, deps.save)
    if (integrationEndpoint && integrationEndpoint !== JSON.stringify([saved.host, saved.port, saved.username])) {
      afterSaved(() => shellIntegration?.set(saved.id, false))
    }
    if (previousTarget === undefined || previousTarget !== deps.sessions.pool.connectionTarget(saved.id)) {
      deps.sessions.pool.invalidate(saved.id)
      if (previousTarget !== undefined) afterSaved(() => deps.collect?.invalidate(saved.id))
    }
    changed(true)
    return saved
  })
  ipcMain.handle('hosts:delete', (event, id: string) => {
    guard(event)
    deps.vault.deleteHost(requireString(id))
    shellIntegration?.set(id, false)
    deps.runbook?.deleteHost(id)
    changed()
    deps.sessions.pool.invalidate(id)
    return deps.sessions.closeHost(id)
  })
  ipcMain.handle('hosts:duplicate', (event, id: string) => {
    guard(event)
    const copy = deps.vault.duplicateHost(requireString(id))
    changed()
    return copy
  })
  ipcMain.handle('groups:list', (event) => {
    guard(event)
    return deps.vault.listGroups()
  })
  ipcMain.handle('groups:save', (event, input: { id?: string; name: string }) => {
    guard(event)
    const saved = deps.vault.saveGroup(input)
    changed()
    return saved
  })
  ipcMain.handle('groups:delete', (event, id: string) => {
    guard(event)
    deps.vault.deleteGroup(requireString(id))
    changed()
  })
  ipcMain.handle('groups:move', (event, id: string, direction: number) => {
    guard(event)
    deps.vault.moveGroup(requireString(id), direction < 0 ? -1 : 1)
    changed()
  })
  const publicSettings = () => ({
    ...deps.vault.settingsPublic(deps.backup.status().unlocked),
    keystore: safeStorageAvailable()
  })
  ipcMain.handle('settings:get', (event) => {
    guard(event)
    return publicSettings()
  })
  ipcMain.handle('settings:update', (event, patch: SettingsPatch) => {
    guard(event)
    const apply = () => {
      guard(event)
      deps.vault.transaction(() => { deps.vault.updateSettings(patch); deps.save() })
      if (patch.verifySecrets !== undefined) hostSecrets.resetVerification()
      if (patch.theme) afterSaved(() => deps.onTheme(patch.theme!))
      if (patch.language) afterSaved(() => deps.onLanguage?.(deps.vault.snapshot().settings.language))
      changed(true)
      return publicSettings()
    }
    if (patch?.verifySecrets === false && deps.vault.settingsPublic(true).verifySecrets) {
      return hostSecrets.authorize(() => guard(event)).then(apply)
    }
    return apply()
  })
  ipcMain.handle('ssh:connect', (event, input: { hostId: string; cols: number; rows: number } & PersistentOptions) => {
    guard(event)
    return deps.sessions.connect(requireString(input?.hostId), Number(input?.cols), Number(input?.rows), { persistent: input?.persistent, tmuxName: input?.tmuxName })
  })
  ipcMain.handle('ssh:reconnect', (event, sessionId: string, cols: number, rows: number) => {
    guard(event)
    return deps.sessions.reconnect(requireString(sessionId), Number(cols), Number(rows))
  })
  ipcMain.handle('ssh:disconnect', async (event, sessionId: string) => {
    guard(event)
    await deps.sessions.close(requireString(sessionId))
  })
  ipcMain.handle('hostkey:respond', (event, requestId: string, decision: 'reject' | 'once' | 'save') => {
    guard(event)
    if (decision !== 'reject' && decision !== 'once' && decision !== 'save') return
    deps.sessions.respondHostKey(requireString(requestId), decision)
  })
  ipcMain.handle('kbd:respond', (event, requestId: string, answers: string[] | null) => {
    guard(event)
    const safe = Array.isArray(answers) ? answers.map((item) => String(item).slice(0, 1024)).slice(0, 20) : null
    deps.sessions.respondKeyboard(requireString(requestId), safe)
  })
  ipcMain.handle('pty:open', (event, cols: number, rows: number) => {
    guard(event)
    return deps.sessions.openLocal(Number(cols), Number(rows))
  })
  ipcMain.handle('pty:close', async (event, sessionId: string) => {
    guard(event)
    await deps.sessions.close(requireString(sessionId))
  })
  ipcMain.handle('sftp:openHost', (event, hostId: string) => {
    guard(event)
    return deps.sessions.openHostFiles(requireString(hostId))
  })
  ipcMain.handle('sftp:list', (event, sessionId: string, dir?: string) => {
    guard(event)
    return deps.sessions.sftpList(requireString(sessionId), typeof dir === 'string' ? dir : undefined)
  })
  ipcMain.handle('sftp:mkdir', (event, sessionId: string, dir: string) => {
    guard(event)
    return deps.sessions.sftpMkdir(requireString(sessionId), requireString(dir))
  })
  ipcMain.handle('sftp:rename', (event, sessionId: string, from: string, to: string) => {
    guard(event)
    return deps.sessions.sftpRename(requireString(sessionId), requireString(from), requireString(to))
  })
  ipcMain.handle('sftp:remove', (event, sessionId: string, target: string) => {
    guard(event)
    return deps.sessions.sftpRemove(requireString(sessionId), requireString(target))
  })
  ipcMain.handle('sftp:upload', (event, sessionId: string, localPaths: string[], remoteDir: string) => {
    guard(event)
    if (!Array.isArray(localPaths) || localPaths.length > 200) throw new Error('一次选择的路径过多')
    return deps.sessions.upload(requireString(sessionId), localPaths.map(requireString), requireString(remoteDir))
  })
  ipcMain.handle('sftp:download', (event, sessionId: string, remotePath: string, localDir: string) => {
    guard(event)
    return deps.sessions.download(requireString(sessionId), requireString(remotePath), requireString(localDir))
  })
  ipcMain.handle('sftp:cancel', (event, jobId: string) => {
    guard(event)
    deps.sessions.cancel(requireString(jobId))
  })
  ipcMain.handle('sftp:edit', (event, sessionId: string, remotePath: string) => {
    guard(event)
    return deps.sessions.editRemote(requireString(sessionId), requireString(remotePath))
  })
  ipcMain.handle('sftp:jobs', (event, sessionId?: string) => {
    guard(event)
    return deps.sessions.jobsFor(sessionId === undefined ? undefined : requireString(sessionId))
  })
  ipcMain.handle('backup:status', (event) => {
    guard(event)
    return deps.backup.status()
  })
  ipcMain.handle('backup:changePassword', async (event, current: string, next: string, remember: boolean) => {
    guard(event)
    return deps.backup.changePassword(requireString(current), requireString(next), Boolean(remember))
  })
  ipcMain.handle('backup:setPassword', async (event, password: string, remember: boolean) => {
    guard(event)
    return deps.backup.setPassword(requireString(password), Boolean(remember))
  })
  ipcMain.handle('backup:unlock', async (event, password: string, remember: boolean) => {
    guard(event)
    return deps.backup.unlock(requireString(password), Boolean(remember))
  })
  ipcMain.handle('backup:lock', async (event) => {
    guard(event)
    return deps.backup.lock()
  })
  ipcMain.handle('backup:auto', async (event) => {
    guard(event)
    return deps.backup.auto()
  })
  ipcMain.handle('backup:export', async (event, filePath: string, password: string | null) => {
    guard(event)
    return deps.backup.exportTo(requireString(filePath), password ? requireString(password) : null)
  })
  ipcMain.handle('backup:import', async (event, filePath: string, password: string | null, mode: 'merge' | 'replace') => {
    guard(event)
    await deps.backup.importFrom(requireString(filePath), password ? requireString(password) : null, mode === 'replace' ? 'replace' : 'merge')
    restored()
  })
  ipcMain.handle('backup:list', async (event) => {
    guard(event)
    return deps.backup.listLocal()
  })
  ipcMain.handle('backup:webdav', async (event, direction: 'push' | 'pull', password: string | null, mode: 'merge' | 'replace', requestId: string) => {
    guard(event)
    await deps.backup.webdav(direction === 'pull' ? 'pull' : 'push', password ? requireString(password) : null, mode === 'replace' ? 'replace' : 'merge', requireString(requestId))
    if (direction === 'pull') restored()
  })
  ipcMain.handle('backup:webdavCancel', (event, requestId: string) => {
    guard(event)
    deps.backup.cancelWebdav(requireString(requestId))
  })
  ipcMain.handle('dialog:pick', async (event, kind: 'files' | 'directory' | 'key') => {
    guard(event)
    const win = deps.getWindow()
    if (!win) return []
    const sshDir = kind === 'key' ? path.join(os.homedir(), '.ssh') : undefined
    const properties: Electron.OpenDialogOptions['properties'] = kind === 'directory'
      ? ['openDirectory']
      : kind === 'key'
        ? ['openFile']
        : process.platform === 'darwin'
          ? ['openFile', 'openDirectory', 'multiSelections']
          : ['openFile', 'multiSelections']
    const result = await dialog.showOpenDialog(win, {
      ...(sshDir && fs.existsSync(sshDir) ? { defaultPath: sshDir } : {}),
      properties
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('dialog:saveBackup', async (event) => {
    guard(event)
    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      defaultPath: 'vault.hopline-backup',
      filters: [{ name: 'Hopline backup', extensions: ['hopline-backup'] }]
    })
    return result.canceled ? null : result.filePath ?? null
  })
  ipcMain.handle('dialog:openBackup', async (event) => {
    guard(event)
    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Hopline backup', extensions: ['hopline-backup'] }]
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('clipboard:read', (event) => {
    guard(event)
    return clipboard.readText()
  })
  ipcMain.handle('clipboard:write', (event, text: string) => {
    guard(event)
    clipboard.writeText(String(text).slice(0, 1_000_000))
  })
  ipcMain.handle('shell:openExternal', async (event, url: string) => {
    guard(event)
    const target = requireString(url)
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new Error('链接不合法')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('只打开 http(s) 链接')
    await shell.openExternal(parsed.toString())
  })
  ipcMain.handle('shell:showItem', (event, filePath: string) => {
    guard(event)
    shell.showItemInFolder(requireString(filePath))
  })
  ipcMain.handle('window:minimize', (event) => {
    guard(event)
    deps.getWindow()?.minimize()
  })
  ipcMain.handle('window:zoom', (event) => {
    guard(event)
    const win = deps.getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:isMaximized', (event) => {
    guard(event)
    return Boolean(deps.getWindow()?.isMaximized?.())
  })
  ipcMain.handle('window:close', (event) => {
    guard(event)
    deps.getWindow()?.close()
  })
  ipcMain.handle('app:info', (event) => {
    guard(event)
    return {
      name: 'Hopline' as const,
      edition: typeof __HOPLINE_EDITION__ === 'undefined' ? 'community' : __HOPLINE_EDITION__,
      version: deps.version,
      platform: process.platform,
      electron: process.versions.electron ?? '',
      shots: deps.shots,
      userData: deps.userData,
      dataNotices: deps.dataNotices,
      keystoreReadFailed: deps.keystoreReadFailed,
      keystore: safeStorageAvailable()
    }
  })
  ipcMain.handle('app:relaunch', event => { guard(event); deps.onRelaunch?.() })
  ipcMain.handle('app:theme', (event) => {
    guard(event)
    return deps.resolvedTheme()
  })
  if (deps.shots) {
    ipcMain.handle('shots:capture', async (event, name: string) => {
      guard(event)
      const win = deps.getWindow()
      if (!win) throw new Error('没有窗口')
      const image = await win.capturePage()
      const fs = await import('node:fs')
      const path = await import('node:path')
      const dir = process.env.HOPLINE_SHOT_DIR || path.join(deps.userData, 'shots')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${requireString(name).replace(/[^a-z0-9-_]/gi, '')}.png`)
      fs.writeFileSync(file, image.toPNG())
      return file
    })
  }

  ipcMain.on('ssh:write', (event, sessionId: string, data: string) => {
    try {
      guard(event)
    } catch {
      return
    }
    if (typeof sessionId === 'string' && typeof data === 'string') deps.sessions.write(sessionId, data)
  })
  ipcMain.on('ssh:resize', (event, sessionId: string, cols: number, rows: number) => {
    try {
      guard(event)
    } catch {
      return
    }
    if (typeof sessionId === 'string') deps.sessions.resize(sessionId, Number(cols), Number(rows))
  })
  ipcMain.on('pty:write', (event, sessionId: string, data: string) => {
    try {
      guard(event)
    } catch {
      return
    }
    if (typeof sessionId === 'string' && typeof data === 'string') deps.sessions.write(sessionId, data)
  })
  ipcMain.on('pty:resize', (event, sessionId: string, cols: number, rows: number) => {
    try {
      guard(event)
    } catch {
      return
    }
    if (typeof sessionId === 'string') deps.sessions.resize(sessionId, Number(cols), Number(rows))
  })
  return () => hostSecrets.dispose()
}

export function isAppEvent(channel: string): boolean {
  return EVENTS.has(channel)
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('参数不完整')
  return value
}
