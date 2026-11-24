import { credentialsUiSmoke } from './support/credentials-ui-smoke.mjs'
import { releaseScreenshots } from './support/release-screenshots.mjs'
import { generateAgentKey } from './support/mini-agent.mjs'
import { billingUiSmoke } from './support/billing-ui-smoke.mjs'
/** Run with `node tests/renderer-smoke.mjs`. Uses a temporary profile and loopback SSH only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { cleanupUiSmoke } from './support/cleanup-ui-smoke.mjs'
import { firstUseSmoke, updatesSmoke } from './support/release-prep-smoke.mjs'
import { overviewLimitSmoke } from './support/overview-limit-smoke.mjs'
import { hardeningUiSmoke } from './support/hardening-ui-smoke.mjs'
import { startupUiSmoke } from './support/startup-ui-smoke.mjs'
import { readinessUiSmoke } from './support/readiness-ui-smoke.mjs'
import { connectionSettingsSmoke, securityPageSmoke } from './support/connection-security-smoke.mjs'
import { windowsTerminalSmoke } from './support/windows-terminal-smoke.mjs'
const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const pty = require('node-pty')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-renderer-smoke-'))
// Keep all screenshots on request; default historical captures are temporary.
const roundScreenshotDirectory = process.env.HOPLINE_SMOKE_SCREENSHOTS || os.tmpdir()
const screenshotDirectory = process.env.HOPLINE_SMOKE_SCREENSHOTS
  ? path.join(roundScreenshotDirectory, 'full') : fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-smoke-history-'))
fs.mkdirSync(roundScreenshotDirectory, { recursive: true })
const smokeWindows = process.env.HOPLINE_SMOKE_NATIVE !== '1'
fs.mkdirSync(screenshotDirectory, { recursive: true })
const sockets = []
const servers = []
let app
let output = ''

async function port() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}

async function sshServer(publicKey) {
  const acceptedKey = publicKey ? utils.parseKey(publicKey) : null
  const clients = new Set()
  const terminals = new Set()
  const directories = new Set(['/'])
  let rejectMkdirOnce = true
  const cleanup = { enabled: false, mode: 'password', checks: 0, applies: [], invalidStdin: 0, commandLeaks: 0, holdRead: null, heldRead: null, stops: 0, holdApply: false, finishApply: null, dfReads: 0, collectReads: 0, securityReads: 0, fullCollection: false, holdSecurity: false, finishSecurity: null }
  const cleanupPassword = 'cleanup-smoke-private'
  const cleanupSizes = { 'docker-build-cache': 1610612736, 'docker-dangling-images': 167772160, 'docker-container-logs': 5368709120, journal: 314572800, 'apt-cache': 67108864, 'rotated-logs': 134217728, 'crash-reports': 1048576, coredumps: 12582912 }

  const server = new Server({ hostKeys: [generateAgentKey().private] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method === 'keyboard-interactive') {
        ctx.prompt([{ prompt: 'Test password', echo: false }], (answers) => {
          if (answers[0] === 'smoke-secret') ctx.accept()
          else ctx.reject()
        })
      } else if (ctx.method === 'publickey' && acceptedKey?.getPublicSSH().equals(ctx.key.data) &&
        (!ctx.signature || acceptedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept()
      else ctx.reject(acceptedKey ? ['publickey', 'keyboard-interactive'] : ['keyboard-interactive'])
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      let cols = 80, rows = 24, terminal
      session.on('pty', (accept, _reject, info) => {
        cols = info.cols; rows = info.rows; accept()
      })
      session.on('window-change', (accept, _reject, info) => {
        terminal?.resize(info.cols, info.rows); accept?.()
      })
      session.on('sftp', (accept) => {
        const stream = accept()
        const handles = new Map()
        let nextHandle = 0
        const attrs = { mode: 0o40755, size: 0, uid: 0, gid: 0, atime: 1, mtime: 1 }
        stream.on('REALPATH', (id, target) => stream.name(id, [{ filename: target === '.' ? '/' : target, longname: '', attrs }]))
        stream.on('STAT', (id, target) => directories.has(target) ? stream.attrs(id, attrs) : stream.status(id, 2))
        stream.on('OPENDIR', (id, target) => {
          if (!directories.has(target)) { stream.status(id, 2); return }
          const handle = Buffer.from(String(++nextHandle))
          handles.set(handle.toString(), { target, read: false })
          stream.handle(id, handle)
        })
        stream.on('READDIR', (id, handle) => {
          const entry = handles.get(handle.toString())
          if (!entry || entry.read) { stream.status(id, 1); return }
          entry.read = true
          const rows = [...directories].filter(dir => dir !== entry.target && path.posix.dirname(dir) === entry.target).map(dir => ({ filename: path.posix.basename(dir), longname: '', attrs }))
          if (rows.length) stream.name(id, rows)
          else stream.status(id, 1)
        })
        stream.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); stream.status(id, 0) })
        stream.on('MKDIR', (id, target) => {
          if (rejectMkdirOnce && target === '/retry-dir') { rejectMkdirOnce = false; setTimeout(() => stream.status(id, 3, 'Permission denied for first attempt'), 150); return }
          directories.add(target); stream.status(id, 0)
        })
        stream.on('RENAME', (id, from, to) => {
          if (!directories.has(from)) { stream.status(id, 2); return }
          directories.delete(from); directories.add(to); stream.status(id, 0)
        })
      })
      // Deterministic remote responses over real loopback SSH; never execute cleanup on the test runner.
      session.on('exec', (accept, reject, info) => {
        if (!cleanup.enabled) { reject(); return }
        const stream = accept(), command = info.command
        let input = ''
        stream.on('data', data => { input += data.toString() })
        stream.on('end', () => {
          const reply = (code, text = '') => { const marker = /hopline-readonly-[a-f0-9]{36}/.exec(command)?.[0]; stream.write(marker ? `${marker} 98765 123456\n${text}\n${marker} done ${code}\n` : text); stream.exit(code); stream.end() }
          if (command.includes(cleanupPassword)) cleanup.commandLeaks++
          if (command.includes('kill -TERM 98765')) {
            if (cleanup.heldRead) { cleanup.stops++; cleanup.heldRead.exit(143); cleanup.heldRead.end(); cleanup.heldRead = null }
            reply(0); return
          }
          if (cleanup.holdRead && (cleanup.holdRead === 'permission' ? command.includes('id -u') : cleanup.holdRead === 'check' ? command.includes('# cleanup:') : command.includes('set -- du -k -x'))) {
            const marker = /hopline-readonly-[a-f0-9]{36}/.exec(command)?.[0]
            assert.ok(marker); stream.write(`${marker} 98765 123456\n`); cleanup.heldRead = stream; cleanup.holdRead = null; return
          }
          if (command === 'sh -s' && input.includes('collect_disk()')) {
            cleanup.collectReads++
            if (cleanup.fullCollection) { reply(0, fs.readFileSync(new URL('./fixtures/collect/alpine.txt', import.meta.url), 'utf8')); return }
            const after = cleanup.applies.length > 0
            reply(0, `===HOPLINE:disk===\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41943040 ${after ? 33554432 : 38587596} ${after ? 8388608 : 3355444} ${after ? 80 : 92}% /\n/dev/vdb1 104857600 52428800 52428800 50% /data\n#HOPLINE-MOUNTS\n/dev/vda1 / ext4 rw 0 0\n/dev/vdb1 /data ext4 rw 0 0\n\n#HOPLINE-END\n`)
            return
          }
          if (command.includes('df -P -k ')) {
            cleanup.dfReads++
            const after = cleanup.applies.length > 0
            reply(0, `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41943040 ${after ? 33554432 : 38587596} ${after ? 8388608 : 3355444} ${after ? 80 : 92}% /\n`); return
          }
          if (command.includes('set -- du -k -x')) { reply(0, '36700160\t/\n20971520\t/var\n10485760\t/var/lib\n4194304\t/usr\n'); return }
          if (command.includes('HOPLINE-CLEANUP:')) {
            if (cleanup.mode === 'password' && input !== cleanupPassword + '\n') { cleanup.invalidStdin++; reply(1); return }
            reply(0, '===HOPLINE-CLEANUP:deleted===\n#HOPLINE-SOURCE lsof\np42\ncworker\nf3\ntREG\nD0x801\ni123\ns1073741824\n#HOPLINE-END\n===HOPLINE-CLEANUP:inodes===\nFilesystem Inodes IUsed IFree IUse% Mounted on\n/dev/vda1 1000 960 40 96% /\n#HOPLINE-END\n===HOPLINE-CLEANUP:logs===\n104857600 2f7661722f6c6f672f6170702e6c6f67\n52428800 2f7661722f6c6f672f6170702e6c6f672e31\n#HOPLINE-END\n'); return
          }
          if (cleanup.fullCollection && command.includes('===HOPLINE:')) { cleanup.securityReads++; const finish = () => { reply(0, fs.readFileSync(new URL('./fixtures/security/unsafe.txt', import.meta.url), 'utf8')); cleanup.finishSecurity = null }; if (cleanup.holdSecurity) cleanup.finishSecurity = finish; else finish(); return }
          const id = /# cleanup:([a-z-]+)/.exec(command)?.[1]
          if (!id && command.includes('id -u')) { reply(0, cleanup.mode === 'root' ? '0\n' : '1000\n'); return }
          if (!id && command.includes('command -v sudo')) { reply(cleanup.mode === 'missing' ? 1 : 0, '/usr/bin/sudo\n'); return }
          if (!id && command.includes('sudo -n true')) { reply(cleanup.mode === 'nopass' ? 0 : 1); return }
          if (cleanup.mode === 'password' && command.includes('sudo -S') && input !== cleanupPassword + '\n') {
            cleanup.invalidStdin++; reply(1); return
          }
          if (id) {
            cleanup.checks++
            if (id === 'tmp-old') { reply(20); return }
            if (!(id in cleanupSizes)) { reply(30, 'cleanup.unavailable\n'); return }
            const bytes = cleanup.applies.includes(id) ? 0 : cleanupSizes[id]
            reply(bytes ? 10 : 0, `bytes=${bytes}\nfixture ${cleanupPassword}\n${id === 'docker-container-logs' ? 'drivers=json-file=2 local=1 journald=1 other=1\n' : ''}`); return
          }
          if (command.includes('apt-get clean')) { const finish = () => { cleanup.applies.push('apt-cache'); reply(0, 'cleaned\n'); cleanup.finishApply = null }; if (cleanup.holdApply) cleanup.finishApply = finish; else finish(); return }
          reply(0)
        })
      })
      session.on('shell', (accept) => {
        const stream = accept()
        terminal = pty.spawn('/bin/sh', [], { cols, rows, cwd: profile, env: { ...process.env, PS1: 'smoke$ ' } })
        terminals.add(terminal)
        terminal.onData((data) => { if (!stream.destroyed) stream.write(data) })
        terminal.onExit(() => { terminals.delete(terminal); if (!stream.destroyed) stream.end() })
        stream.on('data', (data) => terminal.write(data.toString()))
        stream.on('close', () => { terminal.kill(); terminals.delete(terminal) })
      })
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const fixture = {
    directories, cleanup,
    port: server.address().port,
    close: () => {
      for (const client of clients) client.end()
      for (const terminal of terminals) terminal.kill()
      server.close()
    }
  }
  servers.push(fixture)
  return fixture
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
  const events = new Map()
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) { for (const listener of events.get(message.method) ?? []) listener(message.params); return }
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
  const on = (method, listener) => {
    if (!events.has(method)) events.set(method, new Set())
    events.get(method).add(listener)
    return () => events.get(method).delete(listener)
  }
  return { send, evaluate, on }
}

async function unavailableKeystoreSmoke(rendererUrl, evaluate) {
  const root = path.resolve(import.meta.dirname, '..')
  const host = await evaluate(`await hopline.hosts.save({ name: 'Keychain fixture', host: '127.0.0.1', port: 1,
    username: 'fixture', groupId: null, authType: 'password' })`)
  const template = JSON.parse(fs.readFileSync(path.join(profile, 'hopline-store.json'), 'utf8'))
  await evaluate(`hopline.hosts.delete(${JSON.stringify(host.id)})`)
  template.hosts = template.hosts.filter(row => row.id === host.id)
  const savedHost = template.hosts[0]
  savedHost.passwordEnc = 'safe:c3ludGhldGljLWNpcGhlcnRleHQ='
  savedHost.passphraseEnc = 'plain:bGVnYWN5LWZpeHR1cmU='
  template.groups = []
  Object.assign(template.settings, { backgroundStay: false, sidebarCollapsed: false, theme: 'light' })
  Object.assign(template.settings.backup, {
    rememberUnlock: true, kdf: { opslimit: 1, memlimit: 8192, salt: 'fixture' }, verifier: 'fixture'
  })
  const messages = {
    zh: '无法读取系统钥匙串中的 Hopline 密钥。请完全退出 HopLine 后重新打开，在系统提示时输入开机密码并选择「始终允许」。已保存的数据没有丢失。',
    en: 'Unable to read the Hopline key in the system keychain. Quit HopLine completely and reopen it. When prompted, enter your computer login password and select “Always Allow”. Your saved data is intact.'
  }
  const legacy = 'Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.'
  for (const locale of ['zh', 'en']) {
    const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-keychain-denied-'))
    const storeFile = path.join(testProfile, 'hopline-store.json')
    const keyFile = path.join(testProfile, 'backup-key.bin')
    const trace = path.join(testProfile, 'relaunch.txt')
    const entry = path.join(testProfile, 'fixture.cjs')
    const savedKey = Buffer.from('synthetic remembered ciphertext')
    template.settings.language = locale
    const bytes = Buffer.from(JSON.stringify(template, null, 2) + '\n')
    fs.writeFileSync(storeFile, bytes)
    fs.writeFileSync(keyFile, savedKey)
    fs.writeFileSync(path.join(testProfile, 'snapshots.json'), JSON.stringify({ [host.id]: { snapshot: null, error: legacy, updatedAt: null } }))
    const rawMessage = 'Electron fixture: permission denied reading the system keychain'
    fs.writeFileSync(entry, `
      const { app, safeStorage, systemPreferences } = require('electron')
      const fs = require('node:fs')
      const denied = () => { throw new Error(${JSON.stringify(rawMessage)}) }
      safeStorage.isEncryptionAvailable = ${locale === 'zh' ? '() => true' : 'denied'}
      safeStorage.decryptString = denied
      safeStorage.encryptString = () => { throw new Error('Unexpected write to safeStorage') }
      systemPreferences.canPromptTouchID = () => false
      const exit = app.exit.bind(app)
      app.relaunch = () => fs.appendFileSync(${JSON.stringify(trace)}, 'relaunch\\n')
      app.exit = code => { fs.appendFileSync(${JSON.stringify(trace)}, 'exit ' + code + '\\n'); exit(code) }
      require(${JSON.stringify(path.join(root, 'out/main/index.js'))})
    `)
    const debugPort = await port()
    const env = { ...process.env, HOPLINE_USER_DATA: testProfile, ELECTRON_RENDERER_URL: rendererUrl,
      HOPLINE_DISABLE_UPDATE_CHECK: '1', HOPLINE_DISABLE_FX_CHECK: '1' }
    delete env.HOPLINE_DISABLE_KEYSTORE
    const child = spawn(require('electron'), [entry, `--remote-debugging-port=${debugPort}`],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    child.stderr.on('data', data => { logs += data })
    child.stdout.on('data', data => { logs += data })
    const closed = new Promise(resolve => child.once('exit', resolve))
    try {
      const browser = await connectDebugger(debugPort, true)
      const check = async (expression) => {
        for (let i = 0; i < 100; i++) {
          if (await browser.evaluate(`Boolean(${expression})`)) return
          await delay(100)
        }
        throw new Error(`Condition timed out ${expression}\n${await browser.evaluate('document.body.innerText')}`)
      }
      const notice = 'document.querySelector("[data-keystore-notice]")'
      const message = messages[locale]
      const quotedMessage = JSON.stringify(message)
      await check(`${notice}?.textContent.includes(${quotedMessage})`)
      assert.equal(await browser.evaluate(`document.body.innerText.split(${quotedMessage}).length - 1`), 1)
      assert.ok(await browser.evaluate("(await hopline.hosts.list()).some(host=>host.name==='Keychain fixture'&&host.hasPassword)"))
      assert.equal(await browser.evaluate('(await hopline.app.info()).keystoreReadFailed'), true)
      assert.equal(await browser.evaluate('(await hopline.backup.status()).unlocked'), false)
      assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(legacy)})`), false)
      await browser.evaluate('document.fonts.ready')
      const png = await browser.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(roundScreenshotDirectory, `hopline-credentials-keychain-${locale}.png`), Buffer.from(png.data, 'base64'))

      const id = JSON.stringify(host.id)
      for (const operation of [
        `hopline.ssh.connect({hostId:${id},cols:80,rows:24})`, `hopline.sftp.openHost(${id})`,
        `hopline.hosts.copyConnectionCard(${id})`, `hopline.hosts.copySecret(${id},'password')`, `hopline.hosts.revealSecret(${id},'password')`,
        `hopline.security.check(${id})`, `hopline.runbook.plan(${id},'timezone',{TZ:'UTC'})`,
        `hopline.backup.export(${JSON.stringify(path.join(testProfile, 'export'))},'')`
      ]) {
        const error = await browser.evaluate(`await (async()=>{try{await ${operation};return 'resolved'}catch(error){return error.message}})()`)
        assert.equal(error.replace(/^Error invoking remote method '[^']+': (?:Error|KeystoreReadError): /, ''), message, operation)
      }
      assert.equal(await browser.evaluate(`(await hopline.collect.run(${id})).error`), message)
      await check(`${notice}?.textContent.includes(${quotedMessage})`)
      assert.equal(await browser.evaluate(`document.body.innerText.split(${quotedMessage}).length - 1`), 1)
      await browser.evaluate(`document.querySelector('aside [data-host-id="' + ${id} + '"]').click()`)
      await check("document.querySelector('[data-ssh-command]')")
      const button = (label) => `Array.from(document.querySelectorAll('button')).find(button=>button.getClientRects().length&&[button.textContent,button.getAttribute('aria-label')].includes(${JSON.stringify(label)}))`
      await browser.evaluate(`${button(locale === 'zh' ? '打开终端' : 'Open terminal')}.click()`)
      await check(`document.body.innerText.includes(${quotedMessage})`)
      await browser.evaluate(`${button(locale === 'zh' ? '文件' : 'Files')}.click()`)
      await check(`Array.from(document.querySelectorAll('[role=alert]')).some(node=>node.textContent===${quotedMessage})`)
      assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(rawMessage)})`), false)
      assert.deepEqual(fs.readFileSync(storeFile), bytes)
      assert.deepEqual(fs.readFileSync(keyFile), savedKey)
      assert.equal(fs.existsSync(path.join(testProfile, 'export')), false)

      await browser.evaluate("document.querySelector('[data-nav=overview]').click()")
      await check(notice)
      await browser.evaluate(`setTimeout(()=>${notice}.querySelector('button').click(), 50);undefined`)
      for (let i = 0; child.exitCode === null && i < 100; i++) await delay(100)
      assert.equal(child.exitCode, 0)
      assert.equal(fs.readFileSync(trace, 'utf8'), 'relaunch\nexit 0\n')
      assert.deepEqual(fs.readFileSync(storeFile), bytes)
      assert.deepEqual(fs.readFileSync(keyFile), savedKey)
      console.log(`PASS keychain ${locale}: native safeStorage failure, one overview alert, exact IPC messages, unchanged files and relaunch`)
    } catch (error) {
      throw new Error(`Keychain smoke (${locale}) failed: ${error.message}\n${logs}`, { cause: error })
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await closed
      fs.rmSync(testProfile, { recursive: true, force: true })
    }
  }
}

try {
  const remotePort = await port(), inspectPort = await port()
  app = spawn('npm', ['run', 'dev', '--', '--remoteDebuggingPort', String(remotePort), '--inspect', String(inspectPort), ...(process.env.HOPLINE_SMOKE_SOFTWARE_RENDERING === '1' ? ['--', '--disable-gpu'] : [])], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOPLINE_USER_DATA: profile, HOPLINE_DISABLE_UPDATE_CHECK: '1', HOPLINE_DISABLE_FX_CHECK: '1', HOPLINE_DISABLE_KEYSTORE: '1',
      PRELOAD_VITE_HOPLINE_SMOKE_WIN32: smokeWindows ? '1' : '0' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', (data) => { output += data })
  app.stderr.on('data', (data) => { output += data })
  const browser = await connectDebugger(remotePort, true)
  const main = await connectDebugger(inspectPort, false)
  const evaluate = browser.evaluate
  const waitFor = async (expression) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(`Boolean(await (${expression}))`)) return
      await delay(100)
    }
    throw new Error(`Condition timed out: ${expression}\n${await evaluate('document.body.innerText')}`)
  }
  await waitFor("location.protocol === 'http:' && document.readyState === 'complete' && window.hopline")
  await evaluate("window.testState = await import('/src/state/index.ts'); window.testRegistry = await import('/src/terminal/registry.ts')")
  await waitFor('testState.getState().ready')
  assert.equal(await evaluate('testState.getState().bootError'), null)
  await main.evaluate("globalThis.testElectron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); undefined")
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].hide()")
  assert.equal(await evaluate('(await hopline.settings.get()).autoCollect'), true)
  await evaluate("await hopline.settings.update({autoCollect:false});await testState.reloadCatalog()")
  await browser.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1,y:1})
  const key = async (key, code = key) => {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key === 'Enter' ? '\r' : undefined, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[key] })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
    await delay(40)
  }
  const click = async (selector) => {
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 } })()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box })
    await delay(50)
  }
  if (process.env.HOPLINE_SMOKE_RELEASE_ONLY === '1') {
    await evaluate("window.testNav=await import('/src/state/navigation.ts');await hopline.backup.setPassword('release-only-fixture-password',false)")
    await releaseScreenshots({ browser, main, evaluate, waitFor, delay, directory: process.env.HOPLINE_RELEASE_SCREENSHOTS || roundScreenshotDirectory })
  } else if (process.env.HOPLINE_SMOKE_KEYCHAIN_ONLY === '1') {
    await unavailableKeystoreSmoke(await evaluate('location.href'), evaluate)
  } else if (process.env.HOPLINE_SMOKE_USABILITY_ONLY === '1') {
    await firstUseSmoke({ browser, main, evaluate, waitFor, click, key, delay, screenshotDirectory: roundScreenshotDirectory, sshServer, profile, generateAgentKey })
    await evaluate("window.testNav=await import('/src/state/navigation.ts');await hopline.backup.setPassword('usability-fixture-password',false)")
    await credentialsUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory: roundScreenshotDirectory })
    if (process.env.HOPLINE_RELEASE_SCREENSHOTS) await releaseScreenshots({ browser, main, evaluate, waitFor, delay, directory: process.env.HOPLINE_RELEASE_SCREENSHOTS })
  } else if (process.env.HOPLINE_SMOKE_CREDENTIALS_ONLY === '1') {
    await evaluate("window.testNav=await import('/src/state/navigation.ts');await hopline.backup.setPassword('credentials-only-fixture-password',false)")
    await credentialsUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory: roundScreenshotDirectory })
  } else {
  await startupUiSmoke({ browser, main, evaluate, waitFor, click, screenshotDirectory })
  await firstUseSmoke({ browser, main, evaluate, waitFor, click, key, delay, screenshotDirectory: roundScreenshotDirectory, sshServer, profile, generateAgentKey })
  await evaluate("testState.patch({paletteOpen:true,query:''})")
  await waitFor('document.querySelector("[role=combobox]")')
  const hostIndex = await evaluate("Array.from(document.querySelectorAll('[role=option]')).findIndex(item=>item.id==='palette-action:host')")
  assert.ok(hostIndex > 0)
  // Walk toward the host action from wherever the initial selection is (it is not always the first item on Linux).
  const selectedId = () => evaluate('document.querySelector("[aria-selected=true]")?.id')
  const position = (id) => evaluate(`Array.from(document.querySelectorAll('[role=option]')).findIndex((item) => item.id === ${JSON.stringify(id)})`)
  for (let i = 0; i < 40 && await selectedId() !== 'palette-action:host'; i++) {
    await key(await position(await selectedId()) > await position('palette-action:host') ? 'ArrowUp' : 'ArrowDown')
  }
  assert.equal(await selectedId(), 'palette-action:host')
  await key('Enter')
  await waitFor("testState.getState().hostDialog === 'new'")
  await waitFor("document.querySelector('[role=dialog][aria-label=新建主机]')")
  assert.equal(await evaluate("document.querySelector('[role=dialog] button[aria-expanded]')?.getAttribute('aria-expanded')"), 'false')
  await key('Escape')
  await waitFor('testState.getState().hostDialog === false')
  await evaluate("testState.patch({paletteOpen:true,query:'',hosts:Array.from({length:12},(_,i)=>({id:String(i),name:'Host '+i,host:'example.test',username:'test',forwards:[],meta:{provider:null,price:null,currency:null,billingCycle:null,renewAt:null,tags:[],note:null},groupId:null}))})")
  await waitFor('document.querySelector("[role=combobox]")')
  const options = await evaluate("Array.from(document.querySelectorAll('[role=option]')).map(item=>item.id)")
  for (let i = 0; i < options.length + 2; i++) await key('ArrowDown')
  assert.equal(await evaluate('document.querySelector("[aria-selected=true]").id'), options.at(-1))
  assert.ok(await evaluate('document.getElementById("palette-list").scrollTop > 0'))
  await browser.send('Input.insertText', { text: '备份' })
  await waitFor('document.querySelectorAll("[role=option]").length === 2')
  assert.equal(await evaluate('document.querySelector("[aria-selected=true]").id'), 'palette-action:backup-now')
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
  const hover = await evaluate(`(() => {const option=document.getElementById('palette-action:backup');option.scrollIntoView({block:'nearest'});const r=option.getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2}})()`)
  await browser.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1,y:1})
  await browser.send('Input.dispatchMouseEvent', {type:'mouseMoved',...hover})
  await browser.send('Input.dispatchMouseEvent', {type:'mouseMoved',...hover,x:hover.x+5})
  await waitFor("document.querySelector('[aria-selected=true]').id === 'palette-action:backup'")
  await key('ArrowUp')
  await key('Enter')
  await waitFor("testState.getState().settingsOpen === 'backup'")
  assert.ok(await evaluate("testState.getState().toasts.some(t=>t.tone==='warning' && t.text.includes('解锁'))"))
  await waitFor("document.querySelector('[role=dialog] input[type=password]')")
  await key('Escape')
  await waitFor('testState.getState().settingsOpen === false')
  await evaluate("testState.patch({paletteOpen:true,query:'no-such-command'})")
  await waitFor('document.querySelector("[role=combobox]")')
  await key('ArrowDown')
  await key('Enter')
  assert.equal(await evaluate('testState.getState().paletteOpen'), true)
  assert.equal(await evaluate('document.querySelector("[aria-selected=true]") === null'), true)
  await key('Escape')
  assert.equal(await evaluate('testState.getState().query'), '')
  console.log('PASS palette navigation, hover, empty results, boundaries, scrolling, query reset, selected Enter, Escape, unavailable backup')

  // Real form interactions: pending groups are drafts until the atomic host save succeeds.
  await evaluate("await testState.reloadCatalog(); window.testUi = await import('/src/components/ui.tsx'); window.testRegistry = await import('/src/terminal/registry.ts'); window.testNav = await import('/src/state/navigation.ts')")
  await evaluate(`window.fillHost = (label, value) => {
    const field = [...document.querySelectorAll('[role=dialog] label')].find(el => el.querySelector('span')?.textContent === label)
    const input = field.querySelector('input,select')
    const prototype = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}))
  }`)
  const groupsBefore = await evaluate('(await hopline.groups.list()).length')
  await evaluate("testState.patch({hostDialog:'new'})")
  await waitFor("document.querySelector('[role=dialog][aria-label=新建主机]')")
  await evaluate("fillHost('分组','__new__')")
  await waitFor("document.querySelector('[role=dialog]').innerText.includes('新分组名称')")
  await evaluate("fillHost('新分组名称','Canceled group')")
  await key('Escape')
  await waitFor('testState.getState().hostDialog === false')
  assert.equal(await evaluate('(await hopline.groups.list()).length'), groupsBefore)
  await evaluate("testState.patch({hostDialog:'new'})")
  await waitFor("document.querySelector('[role=dialog][aria-label=新建主机]')")
  await evaluate("fillHost('名称','Form smoke host'); fillHost('主机','127.0.0.1'); fillHost('用户名','   '); fillHost('分组','__new__')")
  await waitFor("document.querySelector('[role=dialog]').innerText.includes('新分组名称')")
  await evaluate("fillHost('新分组名称','Form smoke group')")
  await evaluate("document.querySelector('[role=dialog] button[type=submit][form]:not([value])').click()")
  await waitFor("document.querySelector('[role=dialog] [role=alert]')")
  assert.ok(await evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog][data-drawer]')
    const alert = dialog.querySelector('[role=alert]'), form = dialog.querySelector('form')
    const buttons = [...alert.parentElement.querySelectorAll('button[type=submit]')]
    return !form.contains(alert) && buttons.length === 2 && buttons.every(btn => btn.form === form)
      && alert.getBoundingClientRect().bottom < buttons[0].getBoundingClientRect().top
  })()`), 'The backend error remains visible above both associated footer submit buttons')
  assert.equal(await evaluate('(await hopline.groups.list()).length'), groupsBefore)
  assert.ok(await evaluate("[...document.querySelectorAll('[role=dialog] input')].some(input=>input.value==='Form smoke group')"))
  const tabsBeforeEnter = await evaluate('testState.getState().tabs.length')
  await evaluate("fillHost('用户名','smoke'); document.querySelector('[role=dialog] form input').focus()")
  await key('Enter')
  await waitFor('testState.getState().hostDialog === false')
  await evaluate("await testState.reloadCatalog(); window.formHost = testState.getState().hosts.find(host=>host.name==='Form smoke host')")
  assert.equal(await evaluate("testState.getState().groups.find(group=>group.id===formHost.groupId).name"), 'Form smoke group')
  assert.equal(await evaluate('testState.getState().tabs.length'), tabsBeforeEnter, 'Enter defaults to Save without connecting')
  await evaluate('testState.patch({hostDialog:formHost})')
  await waitFor("document.querySelector('[role=dialog] form textarea')")
  assert.equal(await evaluate("document.querySelectorAll('[role=dialog] form textarea').length"), 1)
  await evaluate("document.querySelector('[role=dialog] form button[aria-expanded]').click()")
  await evaluate("Array.from(document.querySelectorAll('[role=dialog] form button')).find(b=>b.textContent.includes('代理')).click()")
  assert.equal(await evaluate("document.querySelectorAll('[role=dialog] form textarea').length"), 1, 'Proxy settings must not introduce another Notes field')
  await key('Escape')
  await click('[aria-label="收起侧栏"]')
  await waitFor('testState.getState().sidebarCollapsed && testState.getState().settings.sidebarCollapsed')
  await evaluate('await hopline.hosts.save(formHost); await testState.reloadCatalog()')
  assert.equal(await evaluate('testState.getState().sidebarCollapsed'), true)
  assert.equal(await evaluate(`document.querySelector('aside[aria-label="导航"]') === null`), true)
  await click('[aria-label="展开侧栏"]')
  await waitFor('!testState.getState().sidebarCollapsed && !testState.getState().settings.sidebarCollapsed')
  console.log('PASS collapsed sidebar remains collapsed after saving a host and reloading the catalog')
  const tabsBefore = await evaluate('testState.getState().tabs.length')
  await click(`[data-host-id="${await evaluate('formHost.id')}"]`)
  await waitFor("testState.getState().route.page==='host' && document.querySelector('nav[aria-label=主机功能]')")
  assert.equal(await evaluate('testState.getState().tabs.length'), tabsBefore)
  await evaluate("await hopline.hosts.delete(formHost.id); await hopline.groups.delete(formHost.groupId); await testState.reloadCatalog(); testNav.navigate({page: 'overview'})")
  console.log('PASS host drawer draft group cancellation, failed save retains inputs, atomic group association, host selection does not connect')
  await click('[data-action="new-group"]')
  await waitFor("document.querySelector('[role=dialog] input')")
  await browser.send('Input.insertText', {text:'Sidebar smoke group'})
  await key('Enter')
  await waitFor("!document.querySelector('[role=dialog]') && testState.getState().groups.some(g=>g.name==='Sidebar smoke group')")
  await evaluate("await hopline.groups.delete(testState.getState().groups.find(g=>g.name==='Sidebar smoke group').id); await testState.reloadCatalog()")
  console.log('PASS sidebar creates a group through the application input dialog')


  for (const hostKeyEscape of [true, false]) {
    await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].webContents.send('hostkey:prompt',{requestId:'cancel-host-${hostKeyEscape}',host:'example.test',port:22,keyType:'ssh-ed25519',fingerprint:'test',mismatch:false})`)
    await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].webContents.send('kbd:prompt',{requestId:'cancel-kbd-${hostKeyEscape}',name:'',instructions:'',prompts:[{prompt:'Test password',echo:false}]})`)
    await waitFor("testState.getState().prompts.length === 2 && document.querySelector('[role=dialog]').innerText.includes('example.test:22')")
    const backdrop = async () => {
      await browser.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,x:5,y:5})
      await browser.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,x:5,y:5})
    }
    if (hostKeyEscape) await key('Escape')
    else await backdrop()
    await waitFor("testState.getState().prompts.length === 1 && document.querySelector('#kbd-form')")
    if (hostKeyEscape) await backdrop()
    else await key('Escape')
    await waitFor('testState.getState().prompts.length === 0')
  }
  console.log('PASS Escape and backdrop cancellation for both authentication dialog types')

  for (const requestId of ['expired-visible', 'expired-queued']) {
    await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].webContents.send('kbd:prompt',{requestId:${JSON.stringify(requestId)},name:'',instructions:'',prompts:[]})`)
  }
  await waitFor('testState.getState().prompts.length === 2')
  for (const requestId of ['expired-queued', 'expired-visible']) {
    await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].webContents.send('prompt:expired',{requestId:${JSON.stringify(requestId)}})`)
  }
  await waitFor('testState.getState().prompts.length === 0 && !document.querySelector("#kbd-form")')
  console.log('PASS prompt expiration removes visible and queued authentication dialogs')

  const first = await sshServer(), second = await sshServer()
  for (const [index, fixture] of [first, second].entries()) {
    await evaluate(`await hopline.hosts.save(${JSON.stringify({ groupId: null, name: `Smoke ${index + 1}`, host: '127.0.0.1', port: fixture.port, username: 'smoke', authType: 'keyboard-interactive' })})`)
  }
  await evaluate('await testState.reloadCatalog(); testState.getState().hosts.forEach(h=>void testState.connectHost(h))')
  await waitFor('testState.getState().prompts.length === 2')
  assert.equal(await evaluate('document.querySelectorAll("[role=dialog]").length'), 1)
  const firstPromptPort = await evaluate('testState.getState().prompts[0].port')
  assert.ok(await evaluate(`document.querySelector('[role=dialog]').innerText.includes('127.0.0.1:${firstPromptPort}')`))
  await click('[role=dialog] button.bg-accent')
  await waitFor("testState.getState().prompts.length === 2 && testState.getState().prompts[1].kind === 'keyboard'")
  await click('[role=dialog] button.bg-accent')
  await waitFor("testState.getState().prompts.length === 2 && testState.getState().prompts.every(p=>p.kind==='keyboard')")
  await browser.send('Input.insertText', { text: 'smoke-secret' })
  await key('Enter')
  await waitFor('testState.getState().prompts.length === 1')
  assert.equal(await evaluate('document.querySelector("#kbd-form input").value'), '')
  await browser.send('Input.insertText', { text: 'smoke-secret' })
  await key('Enter')
  await waitFor("testState.getState().tabs.filter(t=>t.status==='connected').length === 2")
  console.log('PASS two concurrent SSH hosts, one mixed FIFO dialog at a time, isolated keyboard answers')
  if (smokeWindows) await windowsTerminalSmoke({ browser, main, evaluate, waitFor, click, screenshotDirectory })

  // Navigation and real loopback SFTP work without using the terminal as the file owner.
  await evaluate(`window.fileHost = testState.getState().hosts.find(h=>h.name==='Smoke 1');
    window.extraSnapshot = Object.fromEntries(['os','uptime','cpu','memory','load','disk','listeners','docker','services','web','certs'].map(key=>[key,{status:'unavailable',reason:'not-installed',data:null}]));
    extraSnapshot.collectedAt=Date.now(); extraSnapshot.securityScore=73;
    testState.patch({snapshots:{[fileHost.id]:{snapshot:extraSnapshot,updatedAt:Date.now(),error:null}}}); testNav.navigate({page:'overview'})`)
  await click(`[data-host-id="${await evaluate('fileHost.id')}"]`)
  await waitFor("document.querySelector('nav[aria-label=主机功能]')")
  assert.ok(await evaluate('document.body.innerText.length > 100'))
  for (const [section, label] of [['security','安全'], ['maintenance','维护'], ['assets','资产'], ['status','状态']]) {
    await evaluate(`Array.from(document.querySelectorAll('nav[aria-label=主机功能] button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`)
    await waitFor(`testState.getState().route.section===${JSON.stringify(section)}`)
    assert.ok(await evaluate('document.body.innerText.length > 100'))
  }
  await evaluate("testNav.openHost(fileHost.id,'assets')")
  await waitFor("testState.getState().route.section==='assets'")
  await evaluate(`(()=>{const input=document.querySelector('section[aria-label="Smoke 1"] form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Unsaved provider draft');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await evaluate("testNav.openHost(fileHost.id,'status')")
  await waitFor("testState.getState().route.section==='status'")
  await evaluate("testNav.navigate({page:'overview'})")
  await waitFor("testState.getState().route.page==='overview'")
  await evaluate("testNav.openHost(fileHost.id,'assets')")
  await waitFor("testState.getState().route.section==='assets'")
  assert.equal(await evaluate(`document.querySelector('section[aria-label="Smoke 1"] form input').value`), 'Unsaved provider draft')
  console.log('PASS asset draft survives host section and global navigation without saving')
  await evaluate("testNav.openHost(fileHost.id,'files')")
  await waitFor("document.querySelector('[data-ready=sftp]')")
  assert.equal(await evaluate('testState.getState().tabs.length'), 2)
  await click('[aria-label="新建文件夹"]')
  await waitFor("document.querySelector('[role=dialog] input')")
  await browser.send('Input.insertText', { text: 'retry-dir' })
  await key('Enter')
  await waitFor("document.querySelector('[role=dialog] [role=alert]')")
  assert.equal(await evaluate("document.querySelector('[role=dialog] input').value"), 'retry-dir')
  await waitFor("document.activeElement === document.querySelector('[role=dialog] input') && !document.activeElement.readOnly")
  await key('Enter')
  await waitFor("!document.querySelector('[role=dialog]') && document.querySelector('[data-ready=sftp]')?.innerText.includes('retry-dir')")
  await evaluate(`Array.from(document.querySelectorAll('[data-ready=sftp] button')).find(b=>b.textContent.includes('retry-dir')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:300}))`)
  await waitFor("document.querySelector('#sftp-menu')")
  await evaluate("Array.from(document.querySelectorAll('#sftp-menu button')).find(b=>b.textContent==='重命名').click()")
  await waitFor("document.querySelector('[role=dialog] input')")
  await evaluate(`(()=>{const input=document.querySelector('[role=dialog] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'renamed-dir');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await key('Enter')
  await waitFor("!document.querySelector('[role=dialog]') && document.querySelector('[data-ready=sftp]')?.innerText.includes('renamed-dir')")
  const filesSession = await evaluate('await hopline.sftp.openHost(fileHost.id)')
  const remoteLiteral = '/dir\\literal'
  await evaluate(`await hopline.sftp.mkdir(${JSON.stringify(filesSession)}, ${JSON.stringify(remoteLiteral)})`)
  const listing = await evaluate(`await hopline.sftp.list(${JSON.stringify(filesSession)}, '/')`)
  assert.equal(listing.path, '/')
  assert.ok(listing.entries.some(entry => entry.path === remoteLiteral && entry.name === remoteLiteral.slice(1)))
  assert.equal(await evaluate(`(await hopline.sftp.list(${JSON.stringify(filesSession)}, ${JSON.stringify(remoteLiteral)})).path`), remoteLiteral)
  console.log('PASS loopback SFTP root and POSIX paths with literal backslashes')

  await evaluate("window.otherFileHost=testState.getState().hosts.find(h=>h.name==='Smoke 2');testNav.openHost(otherFileHost.id,'files')")
  await waitFor(`document.querySelector('section[aria-label="Smoke 2"] [data-ready=sftp]')`)
  assert.equal(await evaluate(`document.querySelector('section[aria-label="Smoke 2"] [data-ready=sftp]').innerText.includes('renamed-dir')`), false)
  await evaluate("testNav.openHost(fileHost.id,'files')")
  await waitFor(`document.querySelector('section[aria-label="Smoke 1"] [data-ready=sftp]')?.innerText.includes('renamed-dir')`)
  console.log('PASS switching hosts keeps each independent file directory isolated')
  // A visited Files page must reopen against edited connection settings, never its cached endpoint.
  second.directories.add('/second-endpoint')
  const waitForFileMarker = async (marker) => {
    const visible = `document.querySelector('section[aria-label="Smoke 1"] [data-ready=sftp]')?.innerText.includes(${JSON.stringify(marker)})`
    for (let attempts = 0; attempts < 4; attempts++) {
      await waitFor(`testState.getState().prompts.length>0 || (${visible})`)
      if (await evaluate(`Boolean(${visible})`)) return
      const kind = await evaluate('testState.getState().prompts[0].kind')
      if (kind === 'hostKey') await click('[role=dialog] button.bg-accent')
      else {
        assert.equal(kind, 'keyboard')
        await waitFor("document.querySelector('#kbd-form input')")
        await browser.send('Input.insertText', {text:'smoke-secret'})
        await key('Enter')
      }
    }
    await waitFor(visible)
  }
  await evaluate(`await hopline.hosts.save({...fileHost,port:${second.port}});await testState.reloadCatalog()`)
  await waitForFileMarker('second-endpoint')
  assert.equal(await evaluate(`document.querySelector('section[aria-label="Smoke 1"] [data-ready=sftp]').innerText.includes('renamed-dir')`), false)
  await evaluate('await hopline.hosts.save(fileHost);await testState.reloadCatalog()')
  await waitForFileMarker('renamed-dir')
  assert.equal(await evaluate(`document.querySelector('section[aria-label="Smoke 1"] [data-ready=sftp]').innerText.includes('second-endpoint')`), false)
  console.log('PASS editing a cached host file endpoint switches to the new server, and restoring settings reconnects to the original server')

  await evaluate("testNav.navigate({page:'overview'})")
  await waitFor("testState.getState().route.page==='overview'")
  await evaluate("testNav.openSessions()")
  await waitFor("document.querySelector('.terminal-surface')")
  assert.equal(await evaluate("testState.getState().tabs.filter(t=>t.status==='connected').length"), 2)
  console.log('PASS extra snapshot metadata does not crash, every host section, real SFTP mkdir error/retry and rename, terminal sessions survive page navigation')
  await evaluate(`window.originalTerminal=testRegistry.terminalOf(testState.getState().activeId);
    window.brokenSnapshot={...extraSnapshot,os:{status:'complete',get data(){throw new Error('smoke view failure')}}};
    testState.patch({snapshots:{[fileHost.id]:{snapshot:brokenSnapshot,error:null,updatedAt:Date.now()}}});testNav.openHost(fileHost.id,'status')`)
  await waitFor("Array.from(document.querySelectorAll('[role=alert] h2')).some(el=>el.textContent.includes('此视图暂时无法显示'))")
  assert.ok(await evaluate("Boolean(document.querySelector('[data-nav=sessions]'))"))
  await click('[data-nav="sessions"]')
  await waitFor("testState.getState().route.page==='sessions'")
  assert.equal(await evaluate('originalTerminal===testRegistry.terminalOf(testState.getState().activeId)'), true)
  assert.equal(await evaluate("testState.getState().tabs.filter(t=>t.status==='connected').length"), 2)
  await evaluate(`testState.patch({snapshots:{[fileHost.id]:{snapshot:extraSnapshot,error:null,updatedAt:Date.now()}}});testNav.openHost(fileHost.id,'status')`)
  await waitFor("testState.getState().route.section==='status'")
  await evaluate("Array.from(document.querySelectorAll('[role=alert] button')).find(b=>b.textContent.includes('重新加载此视图')).click()")
  await waitFor("!Array.from(document.querySelectorAll('[role=alert] h2')).some(el=>el.textContent.includes('此视图暂时无法显示'))")
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].showInactive()")
  await evaluate("testNav.openSessions()")
  // Returning from the host view schedules a ResizeObserver fit on the next visible frame.
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  // The fixed 1024px fixture must finish fitting beyond xterm's initial 80 columns.
  await waitFor('testRegistry.terminalOf(testState.getState().activeId).cols > 80')
  console.log('PASS view error boundary preserves navigation and terminal instance; retry restores the view')


  await evaluate('window.sshId = testState.getState().activeId; window.actualSize = {cols:testRegistry.terminalOf(sshId).cols,rows:testRegistry.terminalOf(sshId).rows}; hopline.ssh.write(sshId,"exit\\r")')
  await waitFor("testState.getState().tabs.find(t=>t.id===sshId).status === 'closed'")
  const size = await evaluate('actualSize')
  assert.notDeepEqual(size, { cols: 100, rows: 32 })
  await evaluate('void testState.reconnectTab(sshId)')
  await waitFor("testState.getState().prompts[0]?.kind === 'keyboard' && document.querySelector('#kbd-form input')")
  await browser.send('Input.insertText', { text: 'smoke-secret' })
  await key('Enter')
  await waitFor("testState.getState().tabs.find(t=>t.id===sshId).status === 'connected'")
  const stty = await evaluate(String.raw`await new Promise(resolve => {
    let text = ''
    const off = hopline.on('ssh:data', packet => {
      if (packet.sessionId !== sshId) return
      text += new TextDecoder().decode(packet.data)
      const match = text.match(/^(\d+ \d+)\r?\n/m)
      if (match) { off(); resolve(match[1]) }
    })
    hopline.ssh.write(sshId, 'stty size\r')
  })`)
  assert.equal(stty, `${size.rows} ${size.cols}`)
  console.log(`PASS reconnect with unchanged container: real remote stty size = ${size.rows} ${size.cols}`)

  await evaluate("await hopline.backup.setPassword('renderer-smoke-password',false)")
  const backupCount = await evaluate('(await hopline.backup.list()).length')
  const menuResult = await main.evaluate(`(() => {const e=testElectron;const items=e.Menu.getApplicationMenu().items.flatMap(i=>i.submenu?.items||[]);const item=items.find(i=>['立即备份','Back up now'].includes(i.label));if(!item)return false;item.click();return true})()`)
  assert.equal(menuResult, true)
  await waitFor(`testState.getState().toasts.some(t=>t.text.includes('.hopline-backup'))`)
  assert.ok(await evaluate(`(await hopline.backup.list()).length > ${backupCount}`))
  console.log('PASS native application menu creates an encrypted backup and shows its filename')

  await evaluate("await hopline.settings.update({language:'en'}); await testState.reloadCatalog()")
  const labels = await main.evaluate(`(() => {const walk=items=>items.flatMap(i=>[i.label,...(i.submenu?walk(i.submenu.items):[])]);return walk(testElectron.Menu.getApplicationMenu().items)})()`)
  assert.ok(labels.includes('File') && labels.includes('New Local Terminal'))
  assert.ok(labels.every(label=>!/[\u3400-\u9fff]/.test(label)))
  const local = await evaluate('await hopline.pty.open(80,24)')
  assert.equal(local.title, 'Local terminal')
  await evaluate(`await hopline.pty.close(${JSON.stringify(local.id)})`)
  await evaluate("await hopline.settings.update({language:'zh'}); await testState.reloadCatalog()")
  console.log('PASS preference language updates native menus and new local terminal titles')

  await evaluate("testNav.navigate({page:'settings'})")
  await evaluate("window.findSettings=()=>Array.from(document.querySelectorAll('section.workspace-page')).find(el=>el.querySelector('h1')?.textContent==='设置');undefined")
  await waitFor("testState.getState().route.page==='settings' && findSettings()")
  await evaluate("Array.from(findSettings().querySelectorAll('nav button')).find(button=>button.textContent==='备份').click()")
  await waitFor("Array.from(findSettings().querySelectorAll('label')).some(label=>label.querySelector('span')?.textContent==='地址')")
  await evaluate(`window.findBackupDraft=()=>Array.from(findSettings().querySelectorAll('label')).find(label=>label.querySelector('span')?.textContent==='地址').querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(findBackupDraft(),'https://draft.example.test/webdav');findBackupDraft().dispatchEvent(new Event('input',{bubbles:true}))`)
  await evaluate("Array.from(findSettings().querySelectorAll('nav button')).find(button=>button.textContent==='外观').click()")
  await evaluate("Array.from(findSettings().querySelectorAll('nav button')).find(button=>button.textContent==='备份').click()")
  assert.equal(await evaluate('findBackupDraft().value'), 'https://draft.example.test/webdav')
  await evaluate("testNav.navigate({page:'overview'})")
  await waitFor("testState.getState().route.page==='overview'")
  await evaluate("testNav.navigate({page:'settings'})")
  await waitFor("testState.getState().route.page==='settings'")
  assert.equal(await evaluate('findBackupDraft().value'), 'https://draft.example.test/webdav')
  assert.equal(await evaluate('testState.getState().settings.backup.webdav'), null)
  await evaluate("Array.from(findSettings().querySelectorAll('nav button')).find(button=>button.textContent==='外观').click();testNav.openSessions()")
  console.log('PASS unsaved settings draft survives section and global navigation without persisting')

  await evaluate(`window.testExtensions = await import('/src/ext/index.ts'); await testExtensions.extensionsReady;
    testExtensions.rendererExtensions.settingsPages.push(
      {id:'smoke-broken',label:{zh:'故障扩展',en:'Broken'},render(){throw new Error('smoke render failure')}},
      {id:'smoke-healthy',label:{zh:'正常扩展',en:'Healthy'},render(){return 'healthy extension'}});
    testState.patch({settingsOpen:'pro:smoke-broken'})`)
  await waitFor("document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('扩展页面加载失败')")
  await evaluate("testState.patch({settingsOpen:'pro:smoke-healthy'})")
  await waitFor("document.querySelector('[role=dialog]')?.textContent.includes('healthy extension')")
  await key('Escape')
  await waitFor('testState.getState().settingsOpen === false')
  console.log('PASS a throwing extension renders a local fallback and other settings tabs remain usable')

  await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].webContents.send('edit:synced',{sessionId:'test',remotePath:'/etc/test.conf',conflict:true,recoveredPath:${JSON.stringify(path.join(profile, 'recovered.conf'))}})`)
  await waitFor("window.recoveryNotice = Array.from(document.querySelectorAll('[role=alert]')).find(node=>node.innerText.includes('recovered.conf'))")
  assert.ok(await evaluate("recoveryNotice.innerText.includes('没有写回远端')"))
  // The reveal action is platform-specific: Finder on macOS, the file manager elsewhere.
  const reveal = !smokeWindows && process.platform === 'darwin' ? '在访达中显示' : '在文件夹中显示'
  assert.ok(await evaluate(`recoveryNotice.innerText.includes(${JSON.stringify(reveal)})`))
  assert.ok(await evaluate("(() => {const r=recoveryNotice.getBoundingClientRect();return r.bottom > innerHeight/2 && r.right > innerWidth/2})()"))
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].showInactive()")
  const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = path.join(screenshotDirectory, 'hopline-p0-renderer-smoke.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  console.log(`PASS edit conflict/recovery IPC notification; screenshot: ${screenshotPath}`)
  await evaluate("window.firstSession=testState.getState().tabs.find(tab=>tab.hostId===fileHost.id);await testState.closeTab(firstSession.id);window.independentFileId=await hopline.sftp.openHost(fileHost.id)")
  assert.ok(await evaluate("(await hopline.sftp.list(independentFileId)).entries.some(entry=>entry.name==='renamed-dir')"))
  console.log('PASS independent files remain usable after their host terminal is closed')
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1024,700)")
  await evaluate(`testState.patch({toasts:[],snapshots:{[fileHost.id]:{snapshot:{...extraSnapshot,cpu:{status:'complete',data:{cores:2,usagePercent:32}},disk:{status:'complete',data:[{mountpoint:'/',filesystem:'/dev/vda1',totalBytes:42949672960,usedBytes:40000000000,availableBytes:2949672960,usagePercent:93}]}},error:null,updatedAt:Date.now()}}})`)
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].showInactive()")
  for (const [page, theme] of [['overview','light'], ['host','light'], ['settings','light'], ['overview','dark'], ['host','dark']]) {
    await evaluate(`await hopline.settings.update({theme:${JSON.stringify(theme)}});await testState.reloadCatalog();${page === 'host' ? "testNav.openHost(fileHost.id,'status')" : `testNav.navigate({page:${JSON.stringify(page)}})`}`)
    await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='跳过')?.click()")
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await delay(550)
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    const shot = await browser.send('Page.captureScreenshot', {format:'png'})
    const location = path.join(screenshotDirectory, `hopline-redesign-${page}-${theme}.png`)
    fs.writeFileSync(location,Buffer.from(shot.data,'base64'))
    console.log(`PASS 1024x700 ${page} ${theme}; screenshot: ${location}`)
  }
  // Capture the restrained pending-state tint with cached data in both themes.
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].showInactive()")
  await evaluate(`testState.patch({snapshots:{[fileHost.id]:{...testState.getState().snapshots[fileHost.id],error:'暂时无法连接主机，请稍后刷新。'}}});testNav.openHost(fileHost.id,'status')`)
  for (const theme of ['light', 'dark']) {
    await evaluate(`await hopline.settings.update({theme:${JSON.stringify(theme)}});await testState.reloadCatalog()`)
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await delay(550) // Let theme colors and gauge transitions settle before visual review.
    const shot = await browser.send('Page.captureScreenshot', {format:'png'})
    const location = path.join(screenshotDirectory, `hopline-status-pending-${theme}.png`)
    fs.writeFileSync(location,Buffer.from(shot.data,'base64'))
    console.log(`CAPTURE 1024x700 pending host ${theme}; screenshot: ${location}`)
  }

  await cleanupUiSmoke({ browser, evaluate, waitFor, click, key, delay, screenshotDirectory, first, output: () => output })
  // Advanced options keep their values while folded, without saving a connection.
  await evaluate("testState.patch({hostDialog:{...fileHost,persistent:true,startupCommand:'echo visual-fixture'}})")
  await waitFor("document.querySelector('[role=dialog] button[aria-expanded=true]')")
  await evaluate("document.querySelector('[role=dialog] button[aria-expanded]').click()")
  assert.equal(await evaluate("document.querySelector('[role=dialog] button[aria-expanded]').getAttribute('aria-expanded')"), 'false')
  await evaluate("document.querySelector('[role=dialog] button[aria-expanded]').click()")
  assert.ok(await evaluate("Array.from(document.querySelectorAll('[role=dialog] input')).some(input=>input.value==='echo visual-fixture')"))
  await key('Escape')
  console.log('PASS advanced connection options retain their draft while collapsed')
  await updatesSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory })
  await connectionSettingsSmoke({ browser, main, evaluate, waitFor, click, key, screenshotDirectory, delay })

  // A synthetic report exercises the actual security UI without contacting a server.
  const corePath = '/@fs' + path.resolve(import.meta.dirname, '../src/core/security')
  const securityText = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/security/unsafe.txt'), 'utf8')
  const report = JSON.parse(await evaluate(`await (async () => {
    const {parseSecurity}=await import(${JSON.stringify(corePath + '/parse.ts')});
    const {evaluate,securityScore}=await import(${JSON.stringify(corePath + '/rules.ts')});
    const snapshot=parseSecurity(${JSON.stringify(securityText)},Date.UTC(2026,9,27));
    const results=evaluate(snapshot,{},Date.UTC(2026,9,27));
    return JSON.stringify({snapshot,results,score:securityScore(results),ignores:{}});
  })()`))
  assert.ok(report.snapshot && report.results.length > 0)
  await main.evaluate(`testElectron.ipcMain.removeHandler('security:latest');testElectron.ipcMain.handle('security:latest',()=>(${JSON.stringify(report)}));
    globalThis.polishClipboardHandler=testElectron.ipcMain._invokeHandlers.get('clipboard:write');testElectron.ipcMain.removeHandler('clipboard:write');testElectron.ipcMain.handle('clipboard:write',(_event,text)=>{globalThis.polishCopied=text});undefined`)
  await evaluate("await hopline.settings.update({theme:'light'});await testState.reloadCatalog();testState.patch({securityHost:fileHost.id})")
  await waitFor("document.querySelector('[role=dialog] article')")
  assert.equal(await evaluate("Array.from(document.querySelectorAll('[role=dialog] summary')).some(el=>/原始数据|Raw data|security\\.raw/.test(el.textContent))"), false)
  assert.equal(await evaluate("document.querySelector('[role=dialog]').textContent.includes('展开原始数据')"), false)
  await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='复制命令').click()")
  await waitFor("testState.getState().toasts.some(t=>t.text==='命令已复制')")
  const expectedCommand = await evaluate(`(await import('/src/logic/security.ts')).commandsText(${JSON.stringify(report.results.find(r => r.status === 'fail' && r.fix?.commands).fix.commands)},'zh')`)
  assert.equal(await main.evaluate('globalThis.polishCopied'), expectedCommand)
  await evaluate("testState.patch({toasts:[]})")
  await delay(550)
  const securityShot = await browser.send('Page.captureScreenshot', {format:'png'})
  fs.writeFileSync(path.join(screenshotDirectory,'hopline-polish-security-light.png'),Buffer.from(securityShot.data,'base64'))
  await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='生成分享卡片').click()")
  await waitFor("document.querySelector('[role=dialog] iframe')")
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').checked"),false)
  assert.ok(await evaluate("!document.querySelector('[role=dialog] iframe').srcdoc.includes('127.***.***.1')"))
  await evaluate("document.querySelector('[role=dialog] input[type=checkbox]').click()")
  await waitFor("document.querySelector('[role=dialog] iframe').srcdoc.includes('127.***.***.1')")
  assert.ok(await evaluate("!document.querySelector('[role=dialog] iframe').srcdoc.includes('127.0.0.1')"))
  for (const locale of ['zh','en']) {
    await evaluate(`await hopline.settings.update({language:${JSON.stringify(locale)}});await testState.reloadCatalog()`)
    await waitFor(`document.querySelector('[role=dialog] iframe').srcdoc.includes(${JSON.stringify(locale === 'zh' ? '由 HopLine 检查' : 'Checked by HopLine')})`)
    const html=await evaluate("document.querySelector('[role=dialog] iframe').srcdoc")
    const imagePath=path.join(screenshotDirectory,`hopline-polish-share-${locale}.png`)
    await main.evaluate(`await (async()=>{const card=new testElectron.BrowserWindow({show:false,width:1200,height:630,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true}});
      try {await card.loadURL(${JSON.stringify('data:text/html;charset=utf-8,'+encodeURIComponent(html))});
        await card.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
        const image=await card.webContents.capturePage({x:0,y:0,width:1200,height:630});process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(imagePath)},image.resize({width:1200,height:630}).toPNG());}
      finally {card.destroy()}})()`)
    assert.equal(fs.readFileSync(imagePath).subarray(0,8).toString('hex'),'89504e470d0a1a0a')
    console.log(`CAPTURE security share ${locale}: ${imagePath}`)
  }
  console.log('PASS security has no raw-data entry; exact command copy, private-by-default share and masked opt-in in both languages')
  await securityPageSmoke({ browser, main, evaluate, waitFor, screenshotDirectory, delay }, report)
  await main.evaluate("testElectron.ipcMain.removeHandler('clipboard:write');testElectron.ipcMain.handle('clipboard:write',polishClipboardHandler);delete globalThis.polishClipboardHandler;undefined")
  await overviewLimitSmoke({ browser, main, evaluate, waitFor, click, screenshotDirectory, delay, first })
  await hardeningUiSmoke({ browser, main, evaluate, waitFor, delay, screenshotDirectory })
  await readinessUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory })
  await billingUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory })
  await credentialsUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory: roundScreenshotDirectory })
  await unavailableKeystoreSmoke(await evaluate('location.href'), evaluate)
  if (process.env.HOPLINE_RELEASE_SCREENSHOTS) await releaseScreenshots({ browser, main, evaluate, waitFor, delay, directory: process.env.HOPLINE_RELEASE_SCREENSHOTS })

  }
} catch (error) {
  console.error(error)
  console.error(output.slice(-4000))
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.close()
  for (const server of servers) server.close()
  if (app?.pid) { try { process.kill(-app.pid, 'SIGTERM') } catch {} }
  await delay(500)
  fs.rmSync(profile, { recursive: true, force: true })
  if (!process.env.HOPLINE_SMOKE_SCREENSHOTS) fs.rmSync(screenshotDirectory, { recursive: true, force: true })
}
