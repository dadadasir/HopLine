/// <reference types="vite/client" />
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { hopEvents, type HoplineApi } from '../shared/api'
import { proChannel } from '../ext/channel'

const api: HoplineApi = {
  fx: { read: () => ipcRenderer.invoke('fx:read') },
  updates: {
    preferences: () => ipcRenderer.invoke('updates:preferences'),
    setAutomatic: (enabled) => ipcRenderer.invoke('updates:setAutomatic', enabled),
    check: () => ipcRenderer.invoke('updates:check'),
    openRelease: (url) => ipcRenderer.invoke('updates:openRelease', url)
  },
  persistent: { list: (hostId) => ipcRenderer.invoke('persistent:list', hostId), kill: (hostId, name) => ipcRenderer.invoke('persistent:kill', hostId, name) },
  notify: (id, message, activeId, enabled) => ipcRenderer.invoke('notify:task', id, message, activeId, enabled),
  cleanup: { disk: (hostId, mount) => ipcRenderer.invoke('cleanup:disk', hostId, mount), diagnose: (hostId, password, requestId) => requestId === undefined ? ipcRenderer.invoke('cleanup:diagnose', hostId, password) : ipcRenderer.invoke('cleanup:diagnose', hostId, password, requestId), du: (hostId, mount, requestId) => requestId === undefined ? ipcRenderer.invoke('cleanup:du', hostId, mount) : ipcRenderer.invoke('cleanup:du', hostId, mount, requestId), sudo: (hostId, requestId) => requestId === undefined ? ipcRenderer.invoke('cleanup:sudo', hostId) : ipcRenderer.invoke('cleanup:sudo', hostId, requestId) },
  init: {
    identities: () => ipcRenderer.invoke('init:identities'),
    plan: (hostId, params, auth) => ipcRenderer.invoke('init:plan', hostId, params, auth)
  },
  security: {
    check: (hostId, options) => ipcRenderer.invoke('security:check', hostId, options),
    latest: (hostId) => ipcRenderer.invoke('security:latest', hostId),
    ignore: (hostId, ruleId, note) => ipcRenderer.invoke('security:ignore', hostId, ruleId, note),
    unignore: (hostId, ruleId) => ipcRenderer.invoke('security:unignore', hostId, ruleId),
    share: (hostId, options) => ipcRenderer.invoke('security:share', hostId, options)
  },
  runbook: {
    plan: (hostId, runbookId, params, password, requestId) => requestId !== undefined ? ipcRenderer.invoke('runbook:plan', hostId, runbookId, params, password, requestId) : password === undefined ? ipcRenderer.invoke('runbook:plan', hostId, runbookId, params) : ipcRenderer.invoke('runbook:plan', hostId, runbookId, params, password),
    run: (hostId, planId, selected, sudoPassword) => ipcRenderer.invoke('runbook:run', hostId, planId, selected, sudoPassword),
    cancel: (hostId, planId) => planId === undefined ? ipcRenderer.invoke('runbook:cancel', hostId) : ipcRenderer.invoke('runbook:cancel', hostId, planId)
  },
  oplog: { list: (hostId) => ipcRenderer.invoke('oplog:list', hostId) },
  collect: {
    run: (hostId, authenticated) => authenticated ? ipcRenderer.invoke('collect:run', hostId, true) : ipcRenderer.invoke('collect:run', hostId),
    latest: () => ipcRenderer.invoke('collect:latest'),
    overview: (open) => ipcRenderer.invoke('collect:overview', open)
  },
  forwards: {
    list: () => ipcRenderer.invoke('forwards:list'),
    start: (hostId, ruleId) => ipcRenderer.invoke('forwards:start', hostId, ruleId),
    stop: (hostId, ruleId) => ipcRenderer.invoke('forwards:stop', hostId, ruleId)
  },
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (input) => ipcRenderer.invoke('snippets:save', input),
    delete: (id) => ipcRenderer.invoke('snippets:delete', id)
  },
  // Exercise Windows-specific renderer interactions on CI's Electron host.
  platform: import.meta.env.DEV && import.meta.env.PRELOAD_VITE_HOPLINE_SMOKE_WIN32 === '1' ? 'win32' : process.platform,
  pro: {
    invoke: (name, ...args) => ipcRenderer.invoke(proChannel(name), ...args),
    on: (listener) => api.on('pro:event', listener)
  },
  hosts: {
    importSshConfig: {
      preview: () => ipcRenderer.invoke('hosts:importSshConfig:preview'),
      apply: (hosts, groupId) => ipcRenderer.invoke('hosts:importSshConfig:apply', hosts, groupId)
    },
    list: () => ipcRenderer.invoke('hosts:list'),
    copyConnectionCard: (id) => ipcRenderer.invoke('hosts:copyConnectionCard', id),
    copySecret: (id, field) => ipcRenderer.invoke('hosts:copySecret', id, field),
    revealSecret: (id, field) => ipcRenderer.invoke('hosts:revealSecret', id, field),
    save: (input) => ipcRenderer.invoke('hosts:save', input),
    delete: (id) => ipcRenderer.invoke('hosts:delete', id),
    duplicate: (id) => ipcRenderer.invoke('hosts:duplicate', id)
  },
  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    save: (input) => ipcRenderer.invoke('groups:save', input),
    delete: (id) => ipcRenderer.invoke('groups:delete', id),
    move: (id, direction) => ipcRenderer.invoke('groups:move', id, direction)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },
  ssh: {
    connect: (input) => ipcRenderer.invoke('ssh:connect', input),
    reconnect: (sessionId, cols, rows) => ipcRenderer.invoke('ssh:reconnect', sessionId, cols, rows),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    write: (sessionId, data) => ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    respondHostKey: (requestId, decision) => ipcRenderer.invoke('hostkey:respond', requestId, decision),
    respondKeyboard: (requestId, answers) => ipcRenderer.invoke('kbd:respond', requestId, answers)
  },
  pty: {
    open: (cols, rows) => ipcRenderer.invoke('pty:open', cols, rows),
    write: (sessionId, data) => ipcRenderer.send('pty:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('pty:resize', sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.invoke('pty:close', sessionId)
  },
  sftp: {
    openHost: (hostId) => ipcRenderer.invoke('sftp:openHost', hostId),
    list: (sessionId, dir) => ipcRenderer.invoke('sftp:list', sessionId, dir),
    mkdir: (sessionId, dir) => ipcRenderer.invoke('sftp:mkdir', sessionId, dir),
    rename: (sessionId, from, to) => ipcRenderer.invoke('sftp:rename', sessionId, from, to),
    remove: (sessionId, target) => ipcRenderer.invoke('sftp:remove', sessionId, target),
    upload: (sessionId, localPaths, remoteDir) => ipcRenderer.invoke('sftp:upload', sessionId, localPaths, remoteDir),
    download: (sessionId, remotePath, localDir) => ipcRenderer.invoke('sftp:download', sessionId, remotePath, localDir),
    cancel: (jobId) => ipcRenderer.invoke('sftp:cancel', jobId),
    edit: (sessionId, remotePath) => ipcRenderer.invoke('sftp:edit', sessionId, remotePath),
    jobs: (sessionId) => ipcRenderer.invoke('sftp:jobs', sessionId)
  },
  backup: {
    changePassword: (current, next, remember) => ipcRenderer.invoke('backup:changePassword', current, next, remember),
    status: () => ipcRenderer.invoke('backup:status'),
    setPassword: (password, remember) => ipcRenderer.invoke('backup:setPassword', password, remember),
    unlock: (password, remember) => ipcRenderer.invoke('backup:unlock', password, remember),
    lock: () => ipcRenderer.invoke('backup:lock'),
    auto: () => ipcRenderer.invoke('backup:auto'),
    export: (filePath, password) => ipcRenderer.invoke('backup:export', filePath, password),
    import: (filePath, password, mode) => ipcRenderer.invoke('backup:import', filePath, password, mode),
    list: () => ipcRenderer.invoke('backup:list'),
    webdav: (direction, password, mode, requestId) => ipcRenderer.invoke('backup:webdav', direction, password, mode, requestId),
    cancelWebdav: (requestId) => ipcRenderer.invoke('backup:webdavCancel', requestId)
  },
  dialog: {
    pick: (kind) => ipcRenderer.invoke('dialog:pick', kind),
    saveBackup: () => ipcRenderer.invoke('dialog:saveBackup'),
    openBackup: () => ipcRenderer.invoke('dialog:openBackup')
  },
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.invoke('clipboard:write', text)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    zoom: () => ipcRenderer.invoke('window:zoom'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    close: () => ipcRenderer.invoke('window:close')
  },
  app: {
    capabilities: () => ipcRenderer.invoke('app:capabilities'),
    versionChange: () => ipcRenderer.invoke('app:versionChange'),
    info: () => ipcRenderer.invoke('app:info'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    theme: () => ipcRenderer.invoke('app:theme')
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, listener) => {
    if (!hopEvents.includes(channel)) throw new Error('未知事件')
    const wrapped = (_event: unknown, payload: any) => listener(payload)
    ipcRenderer.on(channel, wrapped as never)
    return () => ipcRenderer.removeListener(channel, wrapped as never)
  },
  captureShot: (name) => ipcRenderer.invoke('shots:capture', name),
  watchdog: { pong: (id) => ipcRenderer.send('watchdog:pong', id), sessions: () => ipcRenderer.invoke('watchdog:sessions') },
  diagnostics: { preview: () => ipcRenderer.invoke('diagnostics:preview'), save: (preview) => ipcRenderer.invoke('diagnostics:save', preview) }
}

contextBridge.exposeInMainWorld('hopline', api)

if (process.argv.includes('--hopline-perf')) {
  let sent = false
  contextBridge.exposeInMainWorld('hoplinePerf', () => {
    if (sent) return
    sent = true
    ipcRenderer.send('perf:first-paint')
  })
  if (process.argv.includes('--hopline-perf-trace')) {
    const sentStages = new Set<string>()
    contextBridge.exposeInMainWorld('hoplinePerfStage', (name: unknown, ...extra: unknown[]) => {
      if (extra.length || (name !== 'renderer-entry' && name !== 'catalog-ready') || sentStages.has(name)) return
      sentStages.add(name)
      ipcRenderer.send('perf:stage', name)
    })
  }
}
