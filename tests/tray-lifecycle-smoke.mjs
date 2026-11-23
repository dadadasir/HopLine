/**
 * Run serially with `node tests/tray-lifecycle-smoke.mjs` on macOS.
 * Real Electron Tray/Menu, temporary application data, and a loopback SSH fixture.
 * The fixture returns canned collection output; it never executes received scripts.
 * Native menu actions are inspected/invoked through the debugger, not screenshoted.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const root = path.resolve(import.meta.dirname, '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-tray-smoke-'))
const screenshots = '/tmp/hopline-m4-e-community'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sockets = []
let app, ssh
let output = ''
let exitStatus = null
let nativeState = null

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Condition timed out: ${label}; native=${JSON.stringify(nativeState)}`)
}

async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}

async function startFixture() {
  let hostKey, parsed, lastError
  for (let i = 0; i < 5; i++) {
    hostKey = utils.generateKeyPairSync('ed25519').private
    parsed = utils.parseKey(hostKey)
    if (!(parsed instanceof Error)) break
    lastError = parsed
  }
  assert.ok(!(parsed instanceof Error), `Invalid test host key: ${lastError}`)
  const clients = new Set()
  const commands = []
  const password = 'tray-smoke-temporary-password'
  const username = 'tray-fixture-user'
  let connections = 0
  const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/collect/alpine.txt'), 'utf8')
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections++
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (acceptExec, rejectExec, info) => {
        commands.push(info.command)
        if (info.command !== 'sh -s') { rejectExec(); return }
        const stream = acceptExec()
        stream.on('error', () => {})
        // Drain stdin without executing or retaining the submitted collection script.
        stream.on('data', () => {})
        stream.once('end', () => { stream.write(fixture); stream.exit(0); stream.end() })
      })
    }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    port: server.address().port, username, password, commands,
    fingerprint: `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`,
    get connections() { return connections },
    get activeConnections() { return clients.size },
    async close() { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)) }
  }
}

async function debuggerFor(debugPort, renderer) {
  let target
  await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      target = list.find(item => renderer ? item.type === 'page' && item.url.startsWith('http') : item.type === 'node')
    } catch {}
    return !!target
  }, `Debugger ${debugPort}`, 25000)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let sequence = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  ws.onclose = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debugger closed')) }
    pending.clear()
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true })
    if (result.exceptionDetails) throw new Error(`${expression}\n${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}

try {
  assert.equal(process.platform, 'darwin', 'This suite verifies the existing macOS window-close behavior')
  ssh = await startFixture()
  const hosts = [
    { id: 'cached', name: '缓存主机' },
    { id: 'failed', name: '上次失败主机' },
    { id: 'uncollected', name: '未采集主机' }
  ].map(host => ({ ...host, host: '127.0.0.1', port: ssh.port, username: ssh.username, authType: 'password',
    passwordEnc: `plain:${Buffer.from(ssh.password).toString('base64')}` }))
  // Legacy migration verifies the new setting defaults to enabled. All credentials
  // are temporary fixture values and keychain access is explicitly disabled below.
  fs.writeFileSync(path.join(profile, 'hopline-store.json'), JSON.stringify({ version: 1, hosts, groups: [], settings: { language: 'zh', theme: 'light', autoCollect: false } }), { mode: 0o600 })
  fs.writeFileSync(path.join(profile, 'known_hosts.json'), JSON.stringify({ entries: [{ host: '127.0.0.1', port: ssh.port, fingerprint: ssh.fingerprint, addedAt: Date.now() }] }))
  fs.writeFileSync(path.join(profile, 'window.json'), JSON.stringify({ x: 80, y: 80, width: 1024, height: 700 }))
  const unavailable = { status: 'unavailable', reason: 'not-applicable' }
  const snapshot = {
    collectedAt: Date.now(), os: unavailable, uptime: unavailable,
    cpu: { status: 'complete', data: { cores: 2, usagePercent: 17 } }, memory: unavailable, load: unavailable,
    disk: { status: 'complete', data: [{ filesystem: '/dev/vda1', mountpoint: '/', totalBytes: 100000, usedBytes: 93000, availableBytes: 7000, usagePercent: 93 }] },
    listeners: unavailable, docker: unavailable, services: unavailable, web: unavailable, certs: unavailable
  }
  fs.writeFileSync(path.join(profile, 'snapshots.json'), JSON.stringify({
    cached: { snapshot, updatedAt: snapshot.collectedAt, error: null },
    failed: { snapshot: null, updatedAt: null, error: 'fixture-only failure evidence' }
  }))
  fs.mkdirSync(screenshots, { recursive: true })
  const remotePort = await port(), inspectPort = await port()
  const env = { ...process.env, HOPLINE_USER_DATA: profile, HOPLINE_DISABLE_UPDATE_CHECK: '1', HOPLINE_DISABLE_FX_CHECK: '1', HOPLINE_DISABLE_KEYSTORE: '1', HOPLINE_EDITION: 'community', HOPLINE_SMOKE: '0', HOPLINE_SHOTS: '0' }
  delete env.HOPLINE_PRO_DIR
  app = spawn('npm', ['run', 'dev', '--', '--remoteDebuggingPort', String(remotePort), '--inspect', String(inspectPort)], {
    cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  app.on('error', error => { output += `\n${error.stack}` })
  app.on('exit', (code, signal) => { exitStatus = { code, signal } })
  app.stdout.on('data', data => { output = (output + data).slice(-100000) })
  app.stderr.on('data', data => { output = (output + data).slice(-100000) })
  const main = await debuggerFor(inspectPort, false)
  // The inspector socket can appear while Electron is still installing its
  // native module loader. Resolve first: requiring the npm stub this early can
  // cache the wrong module and alter the initialization being observed.
  await until(async () => {
    nativeState = await main.evaluate("(()=>{const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');const resolved=require.resolve('electron');if(resolved!=='electron')return {resolved,uptime:process.uptime()};const electron=require('electron');return {resolved,uptime:process.uptime(),tray:typeof electron.Tray,ready:electron.app.isReady()}})()")
    return nativeState?.tray === 'function'
  }, 'Electron native API initialization')
  await main.evaluate(`
    globalThis.trayRequire = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
    globalThis.trayElectron = trayRequire('electron');
    globalThis.trayInstances = new Set(); globalThis.trayMenu = null; globalThis.trayCurrent = null;
    globalThis.traySetMenu = trayElectron.Tray.prototype.setContextMenu;
    trayElectron.Tray.prototype.setContextMenu = function(menu) {
      trayInstances.add(this); globalThis.trayCurrent = this; globalThis.trayMenu = menu;
      return traySetMenu.call(this, menu);
    };
    globalThis.trayDestroy = trayElectron.Tray.prototype.destroy;
    globalThis.trayDestroyed = 0;
    trayElectron.Tray.prototype.destroy = function() {
      const result = trayDestroy.call(this); trayDestroyed++;
      trayRequire('node:fs').writeFileSync(${JSON.stringify(path.join(profile, 'tray-destroy-count'))}, String(trayDestroyed));
      return result;
    };
    undefined
  `)
  const waitFor = (evaluate, expression) => until(() => evaluate(`Boolean(${expression})`), expression)
  const listenerCounts = `({ activate: trayElectron.app.listenerCount('activate'), second: trayElectron.app.listenerCount('second-instance'), allClosed: trayElectron.app.listenerCount('window-all-closed'), theme: trayElectron.nativeTheme.listenerCount('updated'), resume: trayElectron.powerMonitor.listenerCount('resume'), suspend: trayElectron.powerMonitor.listenerCount('suspend') })`
  const aliveTrays = '[...trayInstances].filter(tray => !tray.isDestroyed()).length'
  const menuItems = 'trayMenu.items.map(item => ({ label: item.label, enabled: item.enabled, type: item.type }))'
  const attach = async () => {
    const browser = await debuggerFor(remotePort, true)
    await waitFor(browser.evaluate, "document.readyState === 'complete' && window.hopline")
    await browser.evaluate("window.testState = await import('/src/state/index.ts'); window.testNav = await import('/src/state/navigation.ts'); undefined")
    await waitFor(browser.evaluate, 'testState.getState().ready')
    assert.equal(await browser.evaluate('testState.getState().bootError'), null)
    await waitFor(main.evaluate, 'trayElectron.BrowserWindow.getAllWindows()[0]?.isVisible()')
    assert.equal(await main.evaluate('trayElectron.BrowserWindow.getAllWindows().length'), 1)
    return browser
  }
  let browser = await attach()
  assert.equal(await browser.evaluate('testState.getState().settings.backgroundStay'), true)
  assert.equal(await browser.evaluate('(await hopline.app.capabilities()).overviewHostLimit'), 5, 'This must be a community build')
  // Force a normal settings IPC refresh after interception: the native Tray was
  // already constructed before the debugger attached, and is never replaced by a fake.
  await browser.evaluate("await hopline.settings.update({language:'zh'})")
  await waitFor(main.evaluate, 'trayCurrent && trayMenu')
  assert.equal(await main.evaluate('trayCurrent instanceof trayElectron.Tray && !trayCurrent.isDestroyed()'), true)
  assert.equal(await main.evaluate(aliveTrays), 1)
  const initialMenu = await main.evaluate(menuItems)
  assert.deepEqual(initialMenu.filter(item => item.type !== 'separator').map(item => item.label), [
    '上次采集状态 · 托盘不自动采集', '缓存主机 · CPU 17% · 磁盘 93%', '上次失败主机 · 上次检查失败', '未采集主机 · 尚未采集', '打开主窗口', '退出'
  ])
  assert.ok(initialMenu.slice(0, 4).every(item => !item.enabled), 'Cached rows must be read-only')
  assert.doesNotMatch(JSON.stringify(initialMenu), /127\.0\.0\.1|tray-fixture-user|tray-smoke-temporary-password|fixture-only failure evidence/)
  assert.equal(ssh.commands.length, 0, 'A cached tray must not trigger collection at startup')
  assert.equal(ssh.connections, 0, 'A cached tray must not open SSH at startup')
  fs.writeFileSync(path.join(screenshots, 'native-menu-inspection.json'), JSON.stringify(initialMenu, null, 2))
  const baselineListeners = await main.evaluate(listenerCounts)
  console.log('PASS real native tray and read-only cached CPU/disk/failure/empty rows; no startup SSH')

  const agedMenu = await main.evaluate(`(() => {
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 600001;
      trayMenu.emit('menu-will-show', {});
      return trayMenu.items.map(item => item.label);
    } finally { Date.now = originalNow; }
  })()`)
  assert.equal(agedMenu[1], '缓存主机 · 历史数据，待刷新')
  assert.equal(agedMenu[2], '上次失败主机 · 上次检查失败')
  assert.equal(ssh.commands.length, 0, 'Opening an aged cached menu must not collect')
  assert.equal(ssh.connections, 0, 'Opening an aged cached menu must not connect')
  await main.evaluate("trayMenu.emit('menu-will-show', {}); undefined")
  assert.equal((await main.evaluate(menuItems))[1].label, '缓存主机 · CPU 17% · 磁盘 93%')
  console.log('PASS native Menu open-event recomputes cached age without SSH or collection')

  await browser.evaluate("testNav.navigate({page:'settings'}); undefined")
  await waitFor(browser.evaluate, "document.querySelector('[data-testid=background-setting] input')")
  await main.evaluate('trayElectron.BrowserWindow.getAllWindows()[0].setSize(1024, 700); undefined')
  for (const [theme, language] of [['light', 'zh'], ['dark', 'zh'], ['dark', 'en']]) {
    await browser.evaluate(`testState.patch({settings:await hopline.settings.update({theme:${JSON.stringify(theme)},language:${JSON.stringify(language)}})}); undefined`)
    await waitFor(browser.evaluate, `document.documentElement.classList.contains('dark') === ${theme === 'dark'}`)
    await browser.evaluate("document.querySelector('[data-testid=background-setting]').scrollIntoView({block:'center'}); undefined")
    await delay(150)
    assert.deepEqual(await browser.evaluate('({width:innerWidth,height:innerHeight})'), { width: 1024, height: 700 })
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme}/${language}: horizontal overflow`)
    assert.equal(await browser.evaluate("(() => { const r=document.querySelector('[data-testid=background-setting]').getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth })()"), true, 'Tray setting must be visible')
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(screenshots, `settings-${theme}-${language}.png`), Buffer.from(shot.data, 'base64'))
  }
  assert.ok((await main.evaluate(menuItems)).some(item => item.label === 'Open main window'))
  assert.ok(await browser.evaluate("document.querySelector('[data-testid=background-setting]').innerText.includes('does not collect data or send reminders')"))
  await browser.evaluate("testState.patch({settings:await hopline.settings.update({theme:'system',language:'zh'})}); undefined")
  console.log(`PASS 1024×700 real settings screenshots, Chinese/English and light/dark, no horizontal overflow: ${screenshots}`)

  const collected = await browser.evaluate("await hopline.collect.run('cached')")
  assert.equal(collected.error, null, 'Manual loopback collection must succeed')
  assert.ok(collected.snapshot)
  assert.equal(ssh.commands.length, 1)
  assert.ok(ssh.activeConnections > 0)
  // Keep the already collected host as the sole automatic target. Advance the
  // scheduler clock while its real timers, window events and loopback SSH run.
  await browser.evaluate("await hopline.hosts.delete('failed');await hopline.hosts.delete('uncollected');await hopline.settings.update({autoCollect:true})")
  await main.evaluate("globalThis.trayOriginalNow=Date.now;globalThis.trayClockOffset=0;Date.now=()=>trayOriginalNow()+trayClockOffset;undefined")
  const advance = () => main.evaluate('trayClockOffset+=301_000;undefined')
  let before = ssh.commands.length
  await advance()
  await main.evaluate("trayElectron.BrowserWindow.getAllWindows()[0].emit('focus');undefined")
  await until(() => ssh.commands.length > before, 'An overdue visible host collects after focusing')
  await waitFor(browser.evaluate, `testState.getState().snapshots.cached?.updatedAt > ${collected.updatedAt}`)
  assert.equal(ssh.commands.length, before + 1)
  assert.equal(ssh.connections, 1, 'Automatic collection must reuse the same SSH connection')

  for (const reopen of ['menu', 'activate', 'second-instance']) {
    before = ssh.commands.length
    const beforeConnections = ssh.connections
    const trayIdentity = await main.evaluate('trayInstances.size')
    await main.evaluate('trayElectron.BrowserWindow.getAllWindows()[0].close(); undefined')
    await waitFor(main.evaluate, 'trayElectron.BrowserWindow.getAllWindows().length === 0')
    assert.equal(await main.evaluate(aliveTrays), 1)
    assert.equal(exitStatus, null, 'Closing a window must keep the app running')
    assert.ok(ssh.activeConnections > 0, 'Positive no-poll assertion needs a connected pool')
    // macOS may report system theme changes while all windows are closed.
    await main.evaluate("trayElectron.nativeTheme.themeSource = trayElectron.nativeTheme.shouldUseDarkColors ? 'light' : 'dark'; trayElectron.nativeTheme.emit('updated'); undefined")
    await advance()
    await main.evaluate("trayElectron.powerMonitor.emit('resume'); undefined")
    await delay(500)
    assert.equal(ssh.commands.length, before, 'Hidden community tray must not collect, including theme change and wake')
    assert.equal(ssh.connections, beforeConnections, 'Hidden community tray must not open connections')
    if (reopen === 'menu') {
      await main.evaluate("trayMenu.items.find(item => item.label === '打开主窗口').click(); trayMenu.items.find(item => item.label === '打开主窗口').click(); undefined")
    } else {
      await main.evaluate(`trayElectron.app.emit(${JSON.stringify(reopen)}); trayElectron.app.emit(${JSON.stringify(reopen)}); undefined`)
    }
    browser = await attach()
    assert.equal(await main.evaluate('trayInstances.size'), trayIdentity, 'Reopen must reuse the same tray')
    assert.equal(await main.evaluate(aliveTrays), 1)
    assert.deepEqual(await main.evaluate(listenerCounts), baselineListeners, 'Reopen must not duplicate lifecycle listeners')
    assert.deepEqual(await browser.evaluate('(await hopline.hosts.list()).map(host => host.id)'), ['cached'])
    await until(() => ssh.commands.length > before, 'Reopened window resumes ordinary collection')
    await waitFor(browser.evaluate, 'testState.getState().snapshots.cached?.error === null')
    await delay(100)
    assert.equal(ssh.commands.length, before + 1)
    console.log(`PASS ${reopen}: real tray retained, hidden/wake/theme no polling, single reopened window, listeners stable, visible polling restored`)
  }

  await browser.evaluate("testNav.navigate({page:'settings'}); undefined")
  await waitFor(browser.evaluate, "document.querySelector('[data-testid=background-setting] input')")
  await browser.evaluate("document.querySelector('[data-testid=background-setting] input').click(); undefined")
  await waitFor(browser.evaluate, 'testState.getState().settings.backgroundStay === false')
  await waitFor(main.evaluate, `${aliveTrays} === 0`)
  assert.equal(await main.evaluate('trayCurrent.isDestroyed()'), true)
  const disabledCount = ssh.commands.length
  await main.evaluate('trayElectron.BrowserWindow.getAllWindows()[0].close(); undefined')
  await waitFor(main.evaluate, 'trayElectron.BrowserWindow.getAllWindows().length === 0')
  await advance()
  await delay(300)
  assert.equal(exitStatus, null, 'macOS close still leaves the app available to activate without a tray')
  assert.equal(await main.evaluate(aliveTrays), 0)
  assert.equal(ssh.commands.length, disabledCount)
  await main.evaluate("trayElectron.app.emit('activate'); trayElectron.app.emit('activate'); undefined")
  browser = await attach()
  assert.equal(await browser.evaluate('testState.getState().settings.backgroundStay'), false)
  assert.equal(await main.evaluate(aliveTrays), 0)
  assert.deepEqual(await main.evaluate(listenerCounts), baselineListeners)
  await browser.evaluate("testNav.navigate({page:'settings'}); undefined")
  await waitFor(browser.evaluate, "document.querySelector('[data-testid=background-setting] input')")
  await browser.evaluate("document.querySelector('[data-testid=background-setting] input').click(); undefined")
  await waitFor(browser.evaluate, 'testState.getState().settings.backgroundStay === true')
  await waitFor(main.evaluate, `${aliveTrays} === 1`)
  assert.equal(await main.evaluate('trayInstances.size'), 2, 'Only re-enabling should create a replacement tray')
  assert.equal(await main.evaluate('trayDestroyed'), 1)
  assert.deepEqual(await main.evaluate(listenerCounts), baselineListeners)
  console.log('PASS disable destroys tray; macOS close/activate preserves settings; re-enable creates exactly one replacement')

  await main.evaluate('Date.now=trayOriginalNow;undefined')
  const electronPid = await main.evaluate('process.pid')
  await main.evaluate("setTimeout(() => trayMenu.items.find(item => item.label === '退出').click(), 50); undefined")
  // Closing debugger sessions allows the native quit path to exit without Node's
  // inspector waiting for a debugger to detach. No SIGTERM is used for this assertion.
  for (const socket of sockets) socket.close()
  await until(() => {
    try { process.kill(electronPid, 0); return false }
    catch (error) { if (error.code === 'ESRCH') return true; throw error }
  }, 'Native tray Quit exits Electron', 20000)
  await until(() => exitStatus !== null, 'Development launcher exits after Electron', 10000)
  assert.equal(exitStatus.code, 0, JSON.stringify(exitStatus))
  assert.equal(Number(fs.readFileSync(path.join(profile, 'tray-destroy-count'), 'utf8')), 2, 'Quit must destroy the active native tray')
  await until(() => ssh.activeConnections === 0, 'Quit closes pooled SSH connections')
  assert.ok(ssh.commands.every(command => command === 'sh -s'))
  console.log('PASS real native tray Quit: tray destroyed, SSH closed, Electron and launcher exited normally')
  console.log('Native menu verified through its real Electron object; no native OS menu screenshot is claimed.')
} catch (error) {
  console.error(error)
  console.error(output.slice(-8000))
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  if (app?.pid && !exitStatus) { try { process.kill(-app.pid, 'SIGTERM') } catch {} }
  await delay(500)
  await ssh?.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
