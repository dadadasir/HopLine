import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** Hold the actual lazy module request while a real local PTY sends output. */
export async function startupUiSmoke({ browser, main, evaluate, waitFor, click, screenshotDirectory }) {
  await waitFor("document.querySelector('section[aria-label=\"三步开始使用 HopLine\"]')")
  assert.equal(await evaluate('testState.getState().tabs.length'), 0)
  assert.equal(await evaluate("performance.getEntriesByType('resource').some(row=>row.name.includes('/components/TerminalPane.tsx'))"), false)
  assert.equal(await evaluate("Array.from(document.querySelectorAll('section[aria-label=\"三步开始使用 HopLine\"] button')).some(button=>button.textContent==='从 ~/.ssh/config 导入')"), true)
  const paused = new Set()
  let releasing = false
  const rendererErrors = []
  const moduleRequests = new Set()
  const networkEvents = []
  const offRequests = browser.on('Network.requestWillBeSent', event => {
    if (event.request.url.includes('/components/TerminalPane.tsx')) {
      moduleRequests.add(event.requestId)
      networkEvents.push({ type: 'request', url: event.request.url })
    }
  })
  const offResponses = browser.on('Network.responseReceived', event => {
    if (moduleRequests.has(event.requestId)) networkEvents.push({ type: 'response', status: event.response.status })
  })
  const offFailures = browser.on('Network.loadingFailed', event => {
    if (moduleRequests.has(event.requestId)) networkEvents.push({ type: 'failed', error: event.errorText, canceled: event.canceled })
  })
  const offErrors = browser.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error') rendererErrors.push(event.args.map(value => value.description ?? value.value).join(' '))
  })
  await browser.send('Runtime.enable')
  await browser.send('Network.enable')
  const release = async requestId => {
    await browser.send('Fetch.continueRequest', { requestId })
    paused.delete(requestId)
  }
  const off = browser.on('Fetch.requestPaused', event => {
    paused.add(event.requestId)
    if (releasing) release(event.requestId).catch(error => networkEvents.push({ type: 'release-error', error: String(error) }))
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*/src/components/TerminalPane.tsx*', requestStage: 'Request' }] })
  await main.evaluate('globalThis.startupSize=testElectron.BrowserWindow.getAllWindows()[0].getContentSize();testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1024,700)')
  const capture = async name => {
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(screenshotDirectory, `hopline-startup-${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`CAPTURE startup ${name}: ${file}`)
  }
  try {
    await evaluate('window.startupLocal=(await testState.openLocal()).id')
    await waitFor("document.body.innerText.includes('正在加载终端…')")
    assert.ok(paused.size, 'The terminal module must be pending while the loading state is visible')
    assert.equal(await evaluate('testRegistry.terminalOf(startupLocal)===undefined'), true)
    // The echoed command does not contain the complete marker; wait for real output.
    await evaluate(`new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>{off();reject(Error('early PTY output missing'))},5000);const off=hopline.on('pty:data',event=>{if(event.sessionId!==startupLocal)return;text+=event.data;if(text.includes('HOPLINE_early_READY')){clearTimeout(timer);off();resolve(true)}});hopline.pty.write(startupLocal,"printf HOPLINE_%s_READY early; echo\\r")})`)
    for (const theme of ['light', 'dark']) {
      await evaluate(`await hopline.settings.update({theme:'${theme}'});await testState.reloadCatalog()`)
      await waitFor(`document.documentElement.classList.contains('dark')===${theme === 'dark'}`)
      await capture(`terminal-loading-${theme}`)
    }
    await click('[data-nav=overview]')
    assert.equal(await evaluate('testState.getState().tabs.some(tab=>tab.id===startupLocal)'), true)
    await click('[data-nav=sessions]')
    releasing = true
    await Promise.all([...paused].map(release))
    // Keep interception alive until the resumed request has actually completed.
    // Disabling Fetch while it is in flight can invalidate the request in Chromium.
    await waitFor('testRegistry.terminalOf(startupLocal)')
    await browser.send('Fetch.disable'); off()
    await waitFor("(()=>{const buffer=testRegistry.terminalOf(startupLocal).buffer.active;return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString()).some(line=>line?.includes('HOPLINE_early_READY'))})()")
    assert.equal(await evaluate("testRegistry.searchOf(startupLocal).findNext('HOPLINE_early_READY')"), true)
    await evaluate('window.startupTerm=testRegistry.terminalOf(startupLocal);undefined')
    await click('[data-nav=overview]'); await click('[data-nav=sessions]')
    assert.equal(await evaluate('testRegistry.terminalOf(startupLocal)===startupTerm'), true)
    await capture('terminal-ready-dark')
    console.log('PASS startup has no eager terminal module, delayed chunk retains real PTY output, search works, navigation preserves terminal')
  } catch (error) {
    console.error('Startup UI assertion failed before cleanup:', error, rendererErrors, networkEvents)
    throw error
  } finally {
    releasing = true
    await Promise.all([...paused].map(id => release(id).catch(() => {})))
    await browser.send('Fetch.disable').catch(() => {}); off(); offErrors()
    offRequests(); offResponses(); offFailures()
    await browser.send('Network.disable').catch(() => {})
    await evaluate("if(window.startupLocal)await testState.closeTab(startupLocal);await hopline.settings.update({theme:'light'});await testState.reloadCatalog();testState.patch({route:{page:'overview'},toasts:[]})")
    await waitFor('testState.getState().tabs.length===0')
    await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].setContentSize(...startupSize)')
  }
}
