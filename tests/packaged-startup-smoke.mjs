/** Verify the real minified macOS community bundle with a disposable profile. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { generateAgentKey, startMiniAgent } from './support/mini-agent.mjs'

const root = path.resolve(import.meta.dirname, '..')
const executable = path.join(root, 'release/mac-arm64/Hopline.app/Contents/MacOS/Hopline')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-packaged-startup-'))
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const previousVersion = process.env.HOPLINE_SMOKE_PREVIOUS_VERSION
const shots = process.env.HOPLINE_SMOKE_SCREENSHOTS || os.tmpdir()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, ws, agent, output = '', windowState
try {
  assert.equal(process.platform, 'darwin')
  assert.ok(fs.existsSync(executable), 'Run npm run build:community first')
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  assert.equal(hash(path.resolve(path.dirname(executable), '../Resources/icon.icns')), hash(path.join(root, 'build/mac/icon.icns')))
  const resources = path.resolve(path.dirname(executable), '../Resources')
  const archive = path.join(resources, 'app.asar')
  const asar = createRequire(import.meta.url)('@electron/asar')
  const files = asar.listPackage(archive).map(file => file.replace(/^\//, ''))
  assert.equal(fs.existsSync(path.join(resources, 'default_app.asar')), false)
  assert.equal(files.some(file => /(?:^|\/)pro(?:\/|$)/.test(file)), false)
  const helpers = files.filter(file => path.posix.basename(file) === 'spawn-helper')
  assert.ok(helpers.length, '实包必须包含 node-pty spawn-helper')
  for (const file of helpers) {
    assert.equal(asar.statFile(archive, file).unpacked, true, `${file} 必须解包`)
    const helper = path.join(resources, 'app.asar.unpacked', file)
    assert.equal(fs.statSync(helper).mode & 0o111, 0o111, `${file} 缺少执行权限`)
    fs.accessSync(helper, fs.constants.X_OK)
  }
  console.log(`PASS all ${helpers.length} packaged spawn-helper files are executable`)
  let audited = 0
  for (const target of ['main', 'preload', 'renderer']) {
    const audit = JSON.parse(asar.extractFile(archive, `out/${target}/edition-audit.json`).toString())
    assert.equal(audit.edition, 'community')
    assert.ok(audit.modules.length && audit.modules.every(row => row.private === false && !row.source.includes('<private>')))
    for (const artifact of audit.outputs) {
      assert.equal(createHash('sha256').update(asar.extractFile(archive, `out/${target}/${artifact.file}`)).digest('hex'), artifact.sha256)
      audited++
    }
  }
  const native = files.filter(file => file.endsWith('.node'))
  assert.ok(native.length)
  for (const file of native) {
    assert.equal(asar.statFile(archive, file).unpacked, true)
    assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked', file)))
  }
  console.log(`PASS community ASAR ${files.length} entries, ${audited} audited hashes, ${native.length} native modules unpacked, matching HopLine icon`)
  fs.mkdirSync(shots, { recursive: true })
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HOPLINE_') && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(key)))
  const home = path.join(profile, 'home')
  const localKeyPath = path.join(home, '.ssh', 'fixture')
  const localPublicKey = generateAgentKey().public.trim()
  fs.mkdirSync(path.dirname(localKeyPath), { recursive: true })
  fs.writeFileSync(`${localKeyPath}.pub`, localPublicKey)
  const key = generateAgentKey()
  agent = await startMiniAgent([key.private])
  if (previousVersion) fs.writeFileSync(path.join(profile, 'last-version.json'), JSON.stringify({ version: previousVersion }))
  child = spawn(executable, [`--inspect=127.0.0.1:${port}`], {
    cwd: root, env: { ...env, HOME: home, SSH_AUTH_SOCK: agent.socket, HOPLINE_USER_DATA: profile, HOPLINE_DISABLE_KEYSTORE: '1', HOPLINE_DISABLE_UPDATE_CHECK: '1', HOPLINE_DISABLE_FX_CHECK: '1' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  let target
  for (let n = 0; n < 200 && !target; n++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(row => row.type === 'node') } catch {}
    if (!target) await delay(100)
  }
  assert.ok(target, `Packaged inspector unavailable\n${output}`)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let sequence = 0
  const pending = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  }
  const main = async expression => {
    const result = await new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${expression}`)) }, 15_000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, replMode: true } }))
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const until = async (read, message) => {
    for (let n = 0; n < 150; n++) { if (await read()) return; await delay(100) }
    throw new Error(`Timed out: ${message}; window=${JSON.stringify(windowState)}\n${output}`)
  }
  await until(async () => {
    try {
      // The Node inspector can be reachable before Electron installs its native
      // module resolver. Never execute the workspace's npm Electron stub then.
      windowState = await main(`(()=>{const require=process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});const resolved=require.resolve('electron');if(resolved!=='electron')return {uptime:process.uptime(),resolved};globalThis.electron=require('electron');return {uptime:process.uptime(),resolved,moduleType:typeof electron,ready:electron.app.isReady(),windows:electron.BrowserWindow.getAllWindows().length}})()`)
      return windowState.windows > 0
    } catch (error) { windowState = { error: String(error) }; return false }
  }, 'native application window')
  await main('globalThis.win=electron.BrowserWindow.getAllWindows()[0];win.setContentSize(1024,700)')
  // Explicitly await Electron's promise in the main inspector, and use an async
  // expression in the renderer so API calls are awaited before assertions.
  const evaluate = expression => main(`await win.webContents.executeJavaScript(${JSON.stringify(`(async () => (${expression}))()`)})`)
  await until(async () => {
    try { return await evaluate("document.readyState==='complete' && document.body.innerText.includes('三步开始使用 HopLine')") } catch { return false }
  }, 'rendered onboarding')
  assert.equal(await main('electron.app.isPackaged'), true)
  assert.equal(await main('electron.app.getVersion()'), version)
  assert.equal(await main('electron.app.getPath("userData")'), profile)
  assert.ok((await main('electron.app.getAppPath()')).endsWith('/Contents/Resources/app.asar'))
  const localIdentity = { label: 'fixture.pub', publicKey: localPublicKey, auth: { type: 'privateKey', privateKeyPath: localKeyPath } }
  const agentPublicKey = key.public.trim().split(/\s+/).slice(0, 2).join(' ')
  assert.deepEqual(await evaluate('hopline.init.identities()'), [
    localIdentity,
    { label: 'agent: key-0', publicKey: agentPublicKey, auth: { type: 'agent', socket: agent.socket } }
  ])
  // Verify the actual packaged CSP using an unsafe loopback port: even a broken
  // policy cannot cause this probe to contact the internet or a local service.
  const violation = await evaluate(`new Promise(resolve=>{const done=event=>{clearTimeout(timer);document.removeEventListener('securitypolicyviolation',done);resolve(event?.effectiveDirective??null)};const timer=setTimeout(()=>done(),1500);document.addEventListener('securitypolicyviolation',done);fetch('http://127.0.0.1:1/hopline-fx-csp').catch(()=>{})})`)
  assert.equal(violation, 'connect-src', 'Packaged renderer must retain connect-src self')
  console.log('PASS packaged renderer CSP blocks external-origin connections')
  const preferences = await main('win.webContents.getLastWebPreferences()')
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(await evaluate("typeof window.hoplinePerf==='undefined' && typeof window.hoplinePerfStage==='undefined'"), true)
  // file:// module loads are not consistently listed by Resource Timing.
  // Debugger.enable reports already parsed scripts as well as future ones.
  await main("globalThis.parsedScripts=[];win.webContents.debugger.on('message',(_event,method,params)=>{if(method==='Debugger.scriptParsed')parsedScripts.push(params.url)});win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Debugger.enable')")
  assert.equal(await main("parsedScripts.some(url=>url.includes('/assets/index-') && url.endsWith('.js'))"), true)
  assert.equal(await main("parsedScripts.some(url=>url.includes('/TerminalPane-'))"), false)
  const capture = async name => {
    await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
    const png = await main('(await win.webContents.capturePage()).toPNG().toString("base64")')
    const file = path.join(shots, `hopline-startup-packaged-${name}.png`)
    fs.writeFileSync(file, Buffer.from(png, 'base64')); console.log(`CAPTURE packaged ${name}: ${file}`)
  }
  await evaluate("await hopline.settings.update({theme:'light'})")
  await until(() => evaluate("!document.documentElement.classList.contains('dark')"), 'light theme')
  if (previousVersion) {
    const button = "Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='看看新功能')"
    await until(() => evaluate(`Boolean(${button})`), 'upgrade notice')
    await evaluate(`${button}.click()`)
    await until(() => evaluate(`document.querySelector('[role=dialog]')?.textContent.includes(${JSON.stringify(version)})`), 'current release notes')
    assert.ok(await evaluate("document.querySelectorAll('[role=dialog] li').length >= 3"))
    await evaluate("Promise.all(document.getAnimations().filter(animation=>animation.effect?.target?.closest('[role=dialog]')).map(animation=>animation.finished.catch(()=>{})))")
    await capture('whats-new-light')
    await main("win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})")
    await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'close release notes')
    console.log('PASS packaged upgrade opens the localized release notes')
  }
  await capture('welcome-light')
  // Test empty/error import states through the existing IPC boundary; never read real SSH files.
  await main("globalThis.importCalls=0;globalThis.importFailure=false;electron.ipcMain.removeHandler('hosts:importSshConfig:preview');electron.ipcMain.handle('hosts:importSshConfig:preview',()=>{importCalls++;if(importFailure)throw Error('无法读取测试配置');return {hosts:[],warnings:[]}})")
  const openImport = () => evaluate("Array.from(document.querySelectorAll('section[aria-label=\"三步开始使用 HopLine\"] button')).find(button=>button.textContent==='从 ~/.ssh/config 导入').click()")
  await openImport()
  await until(() => main('importCalls===1'), 'manual import preview')
  await until(() => evaluate("document.querySelector('[role=dialog]')?.textContent.includes('未找到可导入的主机')"), 'empty preview')
  assert.equal(await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent==='导入 0 台')?.disabled"), true)
  assert.equal(await evaluate('(await hopline.hosts.list()).length'), 0)
  await main("win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})")
  await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'close import')
  await main('importFailure=true'); await openImport()
  await until(() => evaluate("document.querySelector('[role=dialog]')?.textContent.includes('无法读取测试配置')"), 'read failure notice')
  await capture('import-error-light')
  await main("win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})")
  await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'close import error')
  await main("(()=>{const flatten=items=>items.flatMap(item=>[item,...(item.submenu?flatten(item.submenu.items):[])]);flatten(electron.Menu.getApplicationMenu().items).find(item=>item.accelerator==='CommandOrControl+T').click()})()")
  await until(() => evaluate("document.querySelectorAll('.xterm').length===1"), 'lazy terminal in packaged file origin')
  assert.equal(await main("parsedScripts.some(url=>url.includes('/TerminalPane-'))"), true)
  await evaluate("(window.packagedTerminal=document.querySelector('.xterm'),window.localId=(await hopline.watchdog.sessions()).find(row=>row.kind==='local').id)")
  await evaluate(`new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>{off();reject(Error('PTY output missing'))},5000);const off=hopline.on('pty:data',event=>{if(event.sessionId!==localId)return;output+=event.data;if(output.includes('HOPLINE_packaged_READY')){clearTimeout(timer);off();resolve(true)}});hopline.pty.write(localId,"printf HOPLINE_%s_READY packaged; echo\\r")})`)
  assert.equal(await evaluate('(await hopline.settings.get()).autoCollect'), true)
  await evaluate('await hopline.settings.update({autoCollect:false})')
  await evaluate("(window.billingPackagedHost=await hopline.hosts.save({name:'Billing fixture',host:'127.0.0.1',port:1,username:'fixture',authType:'password',groupId:null,meta:{price:1000,currency:'USD',billingCycle:'monthly'}}))")
  await evaluate("document.querySelector('[data-nav=overview]').click()")
  await until(() => evaluate("Boolean(document.querySelector('[data-billing-cost]'))"), 'packaged cost card')
  await evaluate("document.querySelector('[data-billing-cost]').click()")
  await until(() => evaluate("Boolean(document.querySelector('[data-billing-table]'))"), 'lazy packaged billing page')
  assert.equal(await main("parsedScripts.some(url=>url.includes('/BillingPage-'))"), true)
  assert.equal(await evaluate('(await hopline.fx.read()).rates.CNY'), 7.3126)
  assert.equal(await evaluate('typeof hopline.fx.refresh'), 'undefined')
  assert.equal(await evaluate("document.querySelector('[data-nav=overview]').getAttribute('aria-current')"), 'page')
  assert.equal(await evaluate("document.querySelectorAll('[data-billing-table] th').length"), 6)
  await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='返回总览').click()")
  await until(() => evaluate("Boolean(document.querySelector('[data-billing-cost]'))"), 'billing back button')
  await evaluate("document.querySelector('[data-nav=settings]').click()")
  await until(() => evaluate("Boolean(document.querySelector('[data-display-currency] button'))"), 'packaged currency setting')
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[data-display-currency] button')).map(o=>o.dataset.value)"), ['auto','CNY','USD'])
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[data-collection-settings] button')).map(option=>[option.dataset.value,option.getAttribute('aria-pressed')])"), [['1','false'],['5','true'],['15','false']])
  // Exercise the packaged credential bridge with a disposable master-password library.
  // Hardware authentication is tested with explicit main-process doubles, never a real prompt.
  await main("globalThis.packagedTouchID={canPrompt:electron.systemPreferences.canPromptTouchID,prompt:electron.systemPreferences.promptTouchID};globalThis.packagedPrompts=0;electron.systemPreferences.canPromptTouchID=()=>true;electron.systemPreferences.promptTouchID=async()=>{packagedPrompts++};undefined")
  try {
    await evaluate("(async()=>{await hopline.backup.setPassword('packaged-credentials-fixture',false);await hopline.settings.update({verifySecrets:false});billingPackagedHost=await hopline.hosts.save({...billingPackagedHost,password:'packaged-fixture-secret'})})()")
    assert.equal(await main('packagedPrompts'), 1, 'Disabling verification must authorize first')
    assert.equal(await evaluate('(await hopline.settings.get()).verifySecrets'), false)
  } finally {
    await main("electron.systemPreferences.canPromptTouchID=packagedTouchID.canPrompt;electron.systemPreferences.promptTouchID=packagedTouchID.prompt;delete globalThis.packagedTouchID;undefined")
  }
  await evaluate("Array.from(document.querySelectorAll('.workspace-page nav button')).find(button=>button.textContent==='备份').click()")
  await until(() => evaluate("Boolean(document.querySelector('[data-verify-secrets]'))"), 'credential verification preference on backup page')
  await evaluate("document.querySelector('aside [data-host-id=\"'+billingPackagedHost.id+'\"]').click()")
  await until(() => evaluate("Boolean(document.querySelector('[data-ssh-command]'))"), 'packaged host heading')
  assert.equal(await evaluate("document.querySelector('[data-ssh-command]').textContent"), 'ssh -p 1 fixture@127.0.0.1')
  assert.equal(await evaluate("JSON.stringify(await hopline.hosts.list()).includes('packaged-fixture-secret')"), false)
  assert.equal(await evaluate("document.querySelector('[aria-label=复制连接信息]')?.title"), '复制连接信息')
  await evaluate("Array.from(document.querySelectorAll('header button')).find(button=>button.textContent==='编辑连接').click()")
  const input = "document.querySelector('[role=dialog] input[placeholder=\"••••••••\"]')"
  await until(() => evaluate(`${input}?.type==='password'&&${input}.value===''`), 'packaged masked saved password')
  await evaluate(`${input}.parentElement.querySelector('button[aria-pressed]').click()`)
  await until(() => evaluate(`${input}?.type==='text'&&${input}.value==='packaged-fixture-secret'`), 'explicit packaged reveal')
  await main("globalThis.packagedClipboardBefore=await electron.clipboard.read();undefined")
  try {
    assert.equal(await evaluate("await hopline.hosts.copyConnectionCard(billingPackagedHost.id)"), undefined)
    assert.equal(await main("await electron.clipboard.readText()"), '名称：Billing fixture\nIP：127.0.0.1\n端口：1\n用户名：fixture\n密码：packaged-fixture-secret')
    assert.equal(await evaluate("await hopline.hosts.copySecret(billingPackagedHost.id,'password')"), undefined)
    assert.equal(await main("await electron.clipboard.readText()"), 'packaged-fixture-secret')
    assert.ok(await main("(await electron.clipboard.read()).some(item=>item.types.includes('electron application/osclipboard;format=\"org.nspasteboard.ConcealedType\"'))"))
  } finally {
    await main("if(packagedClipboardBefore.some(item=>item.types.length))await electron.clipboard.write(await Promise.all(packagedClipboardBefore.filter(item=>item.types.length).map(async item=>new electron.ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)])))))));else electron.clipboard.clear();packagedClipboardBefore=undefined;undefined")
  }
  await evaluate("document.querySelector('[role=dialog] button[type=submit]').click()")
  await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'packaged edit closes on save')
  await evaluate("Array.from(document.querySelectorAll('header button')).find(button=>button.textContent==='编辑连接').click()")
  await until(() => evaluate(`${input}?.type==='password'&&${input}.value===''`), 'packaged reveal cleared on closing the editor')
  await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent==='取消').click()")
  console.log('PASS packaged credential IPC, masked list, explicit local reveal, editor closing and atomic concealed clipboard')
  await evaluate('await hopline.hosts.delete(billingPackagedHost.id)')
  console.log('PASS packaged simplified billing, default FX, read-only bridge and three currency choices')
  await evaluate("document.querySelector('[data-nav=overview]').click()")
  await evaluate("document.querySelector('[data-nav=sessions]').click()")
  assert.equal(await evaluate("document.querySelector('.xterm')===packagedTerminal"), true)
  await evaluate("await hopline.settings.update({theme:'dark'})")
  await until(() => evaluate("document.documentElement.classList.contains('dark')"), 'dark theme')
  await capture('terminal-dark')
  await evaluate('await hopline.pty.close(localId)')
  console.log('PASS real packaged/minified startup, bundle icon resources, secure preferences, no perf bridge, on-demand terminal/PTY, retained navigation, manual import empty/error states')
  // Use the same maintenance entry point as a user. Listing and selecting a key needs no SSH connection.
  const host = await evaluate("hopline.hosts.save({groupId:null,name:'向导测试',host:'127.0.0.1',port:1,username:'fixture',authType:'password'})")
  const clickWhenReady = async (element, description) => {
    await until(() => evaluate(`Boolean(${element})`), description)
    await evaluate(`(${element}).click()`)
  }
  await clickWhenReady(`document.querySelector('[data-host-id="${host.id}"]')`, 'fixture host')
  await clickWhenReady("Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='维护')", 'maintenance tab')
  await clickWhenReady("Array.from(document.querySelectorAll('h3')).find(h=>h.textContent==='新机初始化')?.parentElement.parentElement.querySelector('button')", 'initialize server action')
  const option = "Array.from(document.querySelectorAll('[role=dialog] select option')).find(o=>o.textContent==='agent: key-0')"
  await until(() => evaluate(`Boolean(${option})`), 'agent identity in the wizard')
  await evaluate(`(() => { const o = ${option}; o.selected = true; o.parentElement.dispatchEvent(new Event('change', {bubbles:true})) })()`)
  await until(() => evaluate(`Array.from(document.querySelectorAll('[role=dialog] input')).some(i=>i.value===${JSON.stringify(agentPublicKey)})`), 'selected agent public key')
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('[role=dialog] input')).some(i=>i.value===${JSON.stringify(agent.socket)})`))
  await capture('init-agent-dark')
  await agent.close()
  agent = undefined
  assert.deepEqual(await evaluate('hopline.init.identities()'), [localIdentity])
  console.log('PASS packaged initialization wizard selects the agent public key and socket; local key remains available when the agent stops')
  // Closing the debugger before quitting avoids an inspector keeping the process alive.
  await main('win.webContents.debugger.detach();setTimeout(()=>electron.app.quit(),100);undefined')
  ws.close(); ws = undefined
  await until(async () => child.exitCode !== null, 'normal packaged exit')
  assert.equal(child.exitCode, 0)
} finally {
  ws?.close()
  if (child && child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  await agent?.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
