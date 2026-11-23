/** Run with `node tests/app-lifecycle-smoke.mjs` on macOS. Uses only a temporary profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-lifecycle-smoke-'))
const sockets = []
let app
let output = ''

async function port() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}

async function connectDebugger(debugPort, renderer) {
  let target
  for (let i = 0; i < 200; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      target = list.find((item) => renderer ? item.type === 'page' && item.url.startsWith('http') : item.type === 'node')
      if (target) break
    } catch {}
    await delay(100)
  }
  assert.ok(target, `Debugger ${debugPort} unavailable\n${output}`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  sockets.push(ws)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let sequence = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true }).catch(error => { throw new Error(`${expression}: ${error.message}`) })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  return { send, evaluate }
}

try {
  assert.equal(process.platform, 'darwin', 'Window-close persistence is a macOS behavior')
  // One valid host and one invalid record exercise partial recovery without data loss.
  fs.writeFileSync(path.join(profile, 'hopline-store.json'), JSON.stringify({
    version: 1, groups: [], settings: { language: 'zh', autoCollect: false },
    hosts: [{ id: 'preserved', name: 'Preserved host', host: 'example.test', port: 22, username: 'test', authType: 'password' }, null]
  }))
  fs.writeFileSync(path.join(profile, 'known_hosts.json'), '{broken')
  const remotePort = await port(), inspectPort = await port()
  app = spawn('npm', ['run', 'dev', '--', '--remoteDebuggingPort', String(remotePort), '--inspect', String(inspectPort)], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOPLINE_USER_DATA: profile, HOPLINE_DISABLE_UPDATE_CHECK: '1', HOPLINE_DISABLE_FX_CHECK: '1', HOPLINE_DISABLE_KEYSTORE: '1' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', (data) => { output += data })
  app.stderr.on('data', (data) => { output += data })
  await connectDebugger(remotePort, true)
  const main = await connectDebugger(inspectPort, false)
  await main.evaluate("globalThis.testElectron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); undefined")
  const waitFor = async (evaluate, expression) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(`Boolean(${expression})`)) return
      await delay(100)
    }
    throw new Error(`Condition timed out: ${expression}`)
  }
  const attach = async () => {
    const browser = await connectDebugger(remotePort, true)
    await waitFor(browser.evaluate, "document.readyState === 'complete' && window.hopline")
    await browser.evaluate("window.testState = await import('/src/state/index.ts'); undefined")
    await waitFor(browser.evaluate, 'testState.getState().ready')
    assert.equal(await browser.evaluate('testState.getState().bootError'), null)
    await waitFor(main.evaluate, 'testElectron.BrowserWindow.getAllWindows()[0]?.isVisible()')
    return browser
  }
  let browser = await attach()
  const initialListeners = await main.evaluate("testElectron.nativeTheme.listenerCount('updated')")
  const notices = await browser.evaluate('(await hopline.app.info()).dataNotices')
  assert.deepEqual(notices.map(n => n.kind), ['rejected', 'quarantined'])
  for (const notice of notices) assert.ok(fs.existsSync(notice.path))
  assert.ok(await browser.evaluate("document.querySelector('[role=alert]').innerText.includes('在访达中显示')"))
  assert.equal(await browser.evaluate('testState.getState().hosts[0].name'), 'Preserved host')
  // Intercept just the OS reveal call to verify the button's real IPC path without opening Finder.
  await main.evaluate("globalThis.revealed = []; testElectron.shell.showItemInFolder = p => revealed.push(p); undefined")
  await browser.evaluate("document.querySelector('[role=alert] li button').click()")
  await waitFor(main.evaluate, 'revealed.length === 1')
  assert.equal(await main.evaluate('revealed[0]'), notices[0].path)
  await browser.evaluate("await hopline.backup.setPassword('lifecycle-smoke-password', false)")
  const saved = await browser.evaluate("await hopline.hosts.save({groupId:null,name:'Created before close',host:'saved.test',port:22,username:'test',authType:'password'})")
  for (const event of ['activate', 'activate', 'second-instance']) {
    const evaluate = browser.evaluate
    await evaluate("await testState.openLocal(); window.localId = testState.getState().activeId; window.localOutput = ''; hopline.on('pty:data', p => { if (p.sessionId === localId) localOutput += p.data }); undefined")
    await evaluate("hopline.pty.write(localId, \"printf '__LIFECYCLE_OK__%s__PID_END__\\n' $$\\r\")")
    await waitFor(evaluate, '/__LIFECYCLE_OK__\\d+__PID_END__/.test(localOutput)')
    const pid = await evaluate("Number(localOutput.match(/__LIFECYCLE_OK__(\\d+)__PID_END__/)[1])")
    await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].close()')
    await waitFor(main.evaluate, 'testElectron.BrowserWindow.getAllWindows().length === 0')
    await waitFor(main.evaluate, `(() => { try { process.kill(${pid}, 0); return false } catch (error) { return error.code === 'ESRCH' } })()`)
    // Theme changes while there is no window must not call a destroyed webContents.
    await main.evaluate("testElectron.nativeTheme.themeSource = 'dark'; testElectron.nativeTheme.emit('updated'); undefined")
    await main.evaluate(`testElectron.app.emit('${event}'); testElectron.app.emit('${event}'); undefined`)
    browser = await attach()
    assert.equal(await main.evaluate('testElectron.BrowserWindow.getAllWindows().length'), 1)
    assert.equal(await main.evaluate("testElectron.nativeTheme.listenerCount('updated')"), initialListeners)
    assert.deepEqual(await browser.evaluate('(await hopline.hosts.list()).map(h=>h.id).sort()'), ['preserved', saved.id].sort())
    assert.equal(await browser.evaluate('(await hopline.backup.status()).unlocked'), true)
    assert.deepEqual(await browser.evaluate('(await hopline.app.info()).dataNotices'), notices)
    assert.ok(await browser.evaluate("document.documentElement.classList.contains('dark')"))
    console.log(`PASS ${event}: visible window, hosts intact, backup still unlocked, old PTY exited, theme listener stable`)
  }
  // The application menu also follows the current window after multiple replacements.
  await main.evaluate("testElectron.Menu.getApplicationMenu().items.flatMap(i=>i.submenu?.items||[]).find(i=>i.accelerator==='CommandOrControl+T').click(); undefined")
  await waitFor(browser.evaluate, "testState.getState().tabs.some(t=>t.kind==='local' && t.status==='connected')")
  await browser.evaluate("await hopline.settings.update({language:'en'})")
  await waitFor(browser.evaluate, "document.querySelector('[role=alert]').innerText.includes('Show in Finder')")
  const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = path.join(os.tmpdir(), 'hopline-p0-lifecycle-smoke.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await browser.evaluate("document.querySelector('[role=alert] > div button').click()")
  await waitFor(browser.evaluate, "!document.querySelector('[role=alert]')")
  console.log(`PASS recovery notices, reveal IPC, English translation, dismiss action, current-window menu; screenshot: ${screenshotPath}`)
  // Quit while a secret is still inside its 60-second clipboard lifetime.
  const quitResult = path.join(profile, 'quit-clipboard.json')
  await main.evaluate("globalThis.quitClipboardBefore=await testElectron.clipboard.read();testElectron.systemPreferences.canPromptTouchID=()=>false;undefined")
  await browser.evaluate(`await hopline.hosts.save({...((await hopline.hosts.list()).find(h=>h.id===${JSON.stringify(saved.id)})),password:'lifecycle-quit-fixture'});await hopline.hosts.copySecret(${JSON.stringify(saved.id)},'password')`)
  assert.equal(await main.evaluate('await testElectron.clipboard.readText()'), 'lifecycle-quit-fixture')
  await main.evaluate(`testElectron.app.once('will-quit', event=>{event.preventDefault();void (async()=>{
    const cleared=(await testElectron.clipboard.readText())!=='lifecycle-quit-fixture';
    const originals=quitClipboardBefore.filter(item=>item.types.length);
    if(originals.length)await testElectron.clipboard.write(await Promise.all(originals.map(async item=>new testElectron.ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)])))))));
    else testElectron.clipboard.clear();
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(quitResult)},JSON.stringify({cleared}));
    testElectron.app.exit(cleared?0:1)
  })()});testElectron.app.quit();undefined`).catch(()=>{})
  for(let attempt=0;attempt<100&&!fs.existsSync(quitResult);attempt++)await delay(50)
  assert.equal(JSON.parse(fs.readFileSync(quitResult,'utf8')).cleared,true)
  console.log('PASS actual before-quit clears the owned secret clipboard before process exit within 60 seconds')
} catch (error) {
  console.error(error)
  console.error(output.slice(-5000))
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  if (app?.pid) { try { process.kill(-app.pid, 'SIGTERM') } catch {} }
  await delay(500)
  fs.rmSync(profile, { recursive: true, force: true })
}
