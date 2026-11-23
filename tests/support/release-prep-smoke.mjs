import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

async function capture({ browser, evaluate, delay, screenshotDirectory }, name) {
  await delay(500)
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(screenshotDirectory, `hopline-m4-c-${name}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`CAPTURE usability ${name}: ${file}`)
}

export async function firstUseSmoke(context) {
  const { main, evaluate, waitFor, click, key, sshServer, generateAgentKey, profile } = context
  assert.equal(await evaluate('testState.getState().hosts.length'), 0)
  assert.equal(await evaluate("localStorage.getItem('hopline.onboarding.v1')"), null)
  const pair = generateAgentKey(), identityPath = path.join(profile, 'collection-fixture-key')
  fs.writeFileSync(identityPath, pair.private, { mode: 0o600 })
  let fixture
  await main.evaluate('globalThis.m4cOriginalSize=testElectron.BrowserWindow.getAllWindows()[0].getContentSize();testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1200,820)')
  const boot = "window.testState=await import('/src/state/index.ts');window.firstNav=await import('/src/state/navigation.ts')"
  const textButton = (container, label) => `Array.from(document.querySelectorAll(${JSON.stringify(container+' button')})).find(button=>button.getClientRects().length&&button.textContent===${JSON.stringify(label)})`
  const field = async (label, value) => evaluate(`(()=>{const field=Array.from(document.querySelectorAll('[data-drawer] label')).find(el=>el.firstElementChild?.textContent===${JSON.stringify(label)});const input=field.querySelector('input,textarea');Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const answer = async () => {
    await waitFor("document.querySelector('#kbd-form input')")
    await evaluate("(()=>{const input=document.querySelector('#kbd-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'smoke-secret');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await evaluate("document.querySelector('#kbd-form').requestSubmit()")
  }
  let report
  for (const locale of ['en', 'zh']) {
    const zh = locale === 'zh'
    fixture = await sshServer(pair.public)
    fixture.cleanup.enabled = true; fixture.cleanup.fullCollection = true
    await evaluate(`await hopline.settings.update({theme:'light',language:'${locale}'});${boot};await testState.reloadCatalog()`)
    await waitFor("document.querySelector('[data-onboarding-step=\"1\"]')")
    assert.equal(await evaluate("document.querySelectorAll('[data-onboarding-step=\"1\"] button').length"), 4)
    assert.ok(await evaluate(`Boolean(${textButton('[data-onboarding-step]', zh ? '从 ~/.ssh/config 导入' : 'Import from ~/.ssh/config')})`))
    await capture(context, `first-welcome-${locale}`)
    await evaluate(`${textButton('[data-onboarding-step]', zh ? '粘贴开通信息' : 'Paste connection details')}.click()`)
    await waitFor("document.querySelector('[data-recognition-text]')")
    await capture(context, `first-paste-${locale}`)
    await key('Escape')
    await key('Escape')
    await evaluate(`${textButton('[data-onboarding-step]', zh ? '手动添加' : 'Add manually')}.click()`)
    await waitFor("document.querySelector('[data-drawer] form')")
    await field(zh ? '主机' : 'Host', '127.0.0.1')
    await field(zh ? '端口' : 'Port', String(fixture.port))
    await field(zh ? '用户名' : 'Username', 'smoke')
    await field(zh ? '备注' : 'Notes', 'loopback fixture')
    await evaluate(`${textButton('[data-drawer]', zh ? '交互' : 'Interactive')}.click()`)
    assert.equal(await evaluate("document.querySelectorAll('[data-drawer] button[type=submit]').length"), 2)
    await capture(context, `first-save-connect-${locale}`)
    const reads = fixture.cleanup.collectReads
    if (zh) {
      await evaluate("document.querySelector('[data-drawer] button[value=connect]').click()")
    } else {
      await evaluate(`${textButton('[data-drawer]', 'Save')}.click()`)
      await waitFor("document.querySelector('[data-onboarding-step=\"2\"]')")
      assert.equal(await evaluate('testState.getState().tabs.length'), 0)
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[data-billing-cost],[data-billing-renewal]')).map(tile=>tile.querySelectorAll('p')[1].textContent)"), ['Not entered','Not entered'])
      await evaluate("document.querySelector('[data-billing-renewal]').click()")
      await waitFor("testState.getState().route.section==='assets' && document.querySelector('textarea')?.value==='loopback fixture'")
      await evaluate(`${textButton('header', 'Edit connection')}.click()`)
      await waitFor("document.querySelector('[data-drawer] textarea')")
      await field('Notes', 'updated in connection editor')
      await evaluate("document.querySelector('[data-drawer] button[type=submit]').click()")
      await waitFor("!testState.getState().hostDialog && document.querySelector('textarea')?.value==='updated in connection editor'")
      await evaluate("firstNav.navigate({page:'overview'})")
      await waitFor("document.querySelector('[data-billing-cost]')")
      await evaluate("document.querySelector('[data-billing-cost]').click()")
      await waitFor("testState.getState().route.section==='assets'")
      await evaluate("firstNav.navigate({page:'overview'})")
      await waitFor("document.querySelector('[data-onboarding-step=\"2\"]')")
      await evaluate(`${textButton('[data-onboarding-step]', 'Connect to 127.0.0.1')}.click()`)
    }
    await waitFor('testState.getState().hosts.length===1 && !testState.getState().hostDialog')
    await evaluate('window.firstUseHost=testState.getState().hosts[0]')
    assert.equal(await evaluate('firstUseHost.name'), '127.0.0.1')
    assert.equal(await evaluate('firstUseHost.authType'), 'keyboard-interactive')
    await waitFor("testState.getState().prompts[0]?.kind==='hostKey'")
    await capture(context, `first-fingerprint-${locale}`)
    await click('[role=dialog] button.bg-accent')
    await waitFor("document.querySelector('#kbd-form input')")
    await capture(context, `first-auth-${locale}`)
    await answer()
    await waitFor("testState.getState().route.hostId===firstUseHost.id && document.querySelector('[data-onboarding-step=\"3\"]')")
    await waitFor("testState.getState().snapshots[firstUseHost.id]?.snapshot?.os?.status==='complete' && !testState.getState().collecting.length")
    assert.ok(fixture.cleanup.collectReads > reads)
    assert.equal(await evaluate('testState.getState().prompts.length'), 0)
    await capture(context, `first-collected-${locale}`)
    await evaluate("firstNav.navigate({page:'settings'})")
    await waitFor("!document.querySelector('[data-onboarding-step]')")
    await evaluate("firstNav.openHost(firstUseHost.id)")
    await waitFor("document.querySelector('[data-onboarding-step=\"3\"]')")
    if (zh) {
      await evaluate(`${textButton('[data-onboarding-step]', '运行安全体检')}.click()`)
      await waitFor("localStorage.getItem('hopline.onboarding.v1')==='true' && testState.getState().securityHost===firstUseHost.id")
      await waitFor("document.querySelector('[role=dialog] article')")
      await capture(context, 'first-security-zh')
      await evaluate("await hopline.settings.update({language:'en'});await testState.reloadCatalog()")
      await capture(context, 'first-security-en')
      await evaluate("await hopline.settings.update({language:'zh'});await testState.reloadCatalog()")
      assert.ok(fixture.cleanup.securityReads > 0)
      report = await evaluate('await hopline.security.latest(firstUseHost.id)')
      assert.ok(report.results.some(row => row.status === 'fail'))
      assert.ok(report.snapshot.collectedAt > 0)
      await key('Escape')
      await evaluate("firstNav.openHost(firstUseHost.id,'security')")
      await waitFor("document.querySelector('section[aria-label] article')")
    } else {
      await evaluate(`${textButton('[data-onboarding-step]', 'Skip')}.click()`)
      await waitFor("localStorage.getItem('hopline.onboarding.v1')==='true' && !document.querySelector('[data-onboarding-step]')")
      await evaluate("firstNav.navigate({page:'overview'})")
      assert.equal(await evaluate("Boolean(document.querySelector('[data-onboarding-step]'))"), false)
      await capture(context, 'first-skipped-en')
      await evaluate("for(const tab of testState.getState().tabs.filter(t=>t.hostId===firstUseHost.id)) await testState.closeTab(tab.id);await hopline.hosts.delete(firstUseHost.id);await testState.reloadCatalog();localStorage.removeItem('hopline.onboarding.v1');localStorage.removeItem('hopline.onboarding.progress');location.reload()")
      fixture.close()
      await waitFor("document.readyState==='complete' && document.querySelector('[data-onboarding-step=\"1\"]')")
    }
  }
  // Returning while a check is still running must not let a cached latest()
  // response clear the running flag or enable mutations against the old report.
  fixture.cleanup.holdSecurity = true
  await evaluate("Array.from(document.querySelectorAll('section[aria-label] button')).find(b=>b.textContent==='重新检查').click()")
  await waitFor("Array.from(document.querySelectorAll('section[aria-label] button')).some(b=>b.textContent==='检查中…'&&b.disabled)")
  for (let i = 0; i < 100 && !fixture.cleanup.finishSecurity; i++) await context.delay(50)
  assert.equal(typeof fixture.cleanup.finishSecurity, 'function')
  await click('[data-nav=overview]')
  await evaluate("firstNav.openHost(firstUseHost.id,'security')")
  await context.delay(250)
  assert.equal(await evaluate("Array.from(document.querySelectorAll('section[aria-label] button')).find(b=>b.textContent==='检查中…')?.disabled"), true)
  assert.equal(await evaluate("Array.from(document.querySelectorAll('section[aria-label] article button')).every(b=>b.disabled)"), true)
  fixture.cleanup.finishSecurity(); fixture.cleanup.holdSecurity = false
  await waitFor("Array.from(document.querySelectorAll('section[aria-label] button')).some(b=>b.textContent==='重新检查'&&!b.disabled)")
  assert.ok((await evaluate('await hopline.security.latest(firstUseHost.id)')).snapshot.collectedAt > report.snapshot.collectedAt)
  await evaluate(`window.autoHost=await hopline.hosts.save({name:'Alpine lab',host:'127.0.0.1',port:${fixture.port},username:'smoke',authType:'privateKey',privateKeyPath:${JSON.stringify(identityPath)},groupId:null,meta:{note:'Local test fixture'}});window.needsHost=await hopline.hosts.save({name:'Interactive lab',host:'127.0.0.1',port:${fixture.port},username:'smoke',authType:'keyboard-interactive',groupId:null});await testState.reloadCatalog();firstNav.navigate({page:'settings'})`)
  await waitFor("document.querySelector('[data-collection-settings] input')")
  await evaluate("document.querySelector('[data-collection-settings] button[data-value=\"15\"]').click()")
  await waitFor("testState.getState().settings.collectionIntervalMinutes===15")
  await evaluate("document.querySelector('[data-collection-settings] input').click()")
  await waitFor("testState.getState().settings.autoCollect")
  const hiddenReads = fixture.cleanup.collectReads
  await context.delay(350)
  assert.equal(fixture.cleanup.collectReads, hiddenReads)
  await evaluate("firstNav.navigate({page:'overview'})")
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].showInactive()")
  await waitFor("testState.getState().snapshots[autoHost.id]?.snapshot?.os?.status==='complete' && testState.getState().snapshots[needsHost.id]?.needsAttention")
  assert.equal(await evaluate('testState.getState().prompts.length'), 0)
  assert.ok(fixture.cleanup.collectReads > hiddenReads, 'visible application collects an authenticated fixture automatically')
  await main.evaluate("globalThis.usabilityCanPrompt=testElectron.systemPreferences.canPromptTouchID;testElectron.systemPreferences.canPromptTouchID=()=>false;globalThis.usabilityClipboard=await testElectron.clipboard.read();undefined")
  try {
    for (const locale of ['zh','en']) {
      const zh = locale === 'zh'
      await evaluate(`await hopline.settings.update({language:'${locale}'});await testState.reloadCatalog();firstNav.navigate({page:'overview'})`)
      await waitFor(textButton('article', zh ? '连接并确认' : 'Connect and confirm'))
      await capture(context, `auto-overview-${locale}`)
      await evaluate("firstNav.openHost(needsHost.id)")
      await waitFor("document.querySelector('[data-collection-attention]')")
      await capture(context, `auto-needs-attention-${locale}`)
      await evaluate("firstNav.openHost(autoHost.id);testState.patch({toasts:[]})")
      const label = zh ? '复制连接信息' : 'Copy connection info'
      await waitFor(`document.querySelector('section[aria-label="Alpine lab"] [aria-label="${label}"]')`)
      await evaluate(`document.querySelector('section[aria-label="Alpine lab"] [aria-label="${label}"]').click()`)
      const copied = zh ? '连接信息已复制，60 秒后清除' : 'Connection info copied. Clears in 60 seconds.'
      await waitFor(`testState.getState().toasts.some(item=>item.text===${JSON.stringify(copied)})`)
      assert.ok((await evaluate('await hopline.clipboard.read()')).endsWith(zh ? '认证：私钥' : 'Auth: Private key'))
      await capture(context, `connection-card-${locale}`)
      await evaluate("firstNav.navigate({page:'settings'});testState.patch({toasts:[]})")
      await waitFor("document.querySelector('[data-collection-settings] input:checked')")
      await evaluate("document.querySelector('[data-collection-settings]').scrollIntoView({block:'end'})")
      await capture(context, `auto-settings-${locale}`)
    }
  } finally {
    await main.evaluate("if(usabilityClipboard.some(item=>item.types.length))await testElectron.clipboard.write(await Promise.all(usabilityClipboard.filter(item=>item.types.length).map(async item=>new testElectron.ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)])))))));else testElectron.clipboard.clear();usabilityClipboard=undefined;testElectron.systemPreferences.canPromptTouchID=usabilityCanPrompt;undefined")
  }
  await evaluate("await hopline.settings.update({language:'zh'});await testState.reloadCatalog();firstNav.openHost(needsHost.id)")
  await waitFor("document.querySelector('[data-collection-attention] button')")
  await evaluate("document.querySelector('[data-collection-attention] button').click()")
  await answer()
  await waitFor("testState.getState().snapshots[needsHost.id]?.snapshot && !testState.getState().snapshots[needsHost.id]?.needsAttention")
  await evaluate("await hopline.settings.update({autoCollect:false,collectionIntervalMinutes:5});for(const tab of testState.getState().tabs.filter(t=>t.hostId===needsHost.id)) await testState.closeTab(tab.id);await hopline.hosts.delete(autoHost.id);await hopline.hosts.delete(needsHost.id);await testState.reloadCatalog()")
  await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].hide()")
  // Restore the suite's original host/session baseline after completing the real journey.
  await evaluate("for(const tab of testState.getState().tabs.filter(t=>t.hostId===firstUseHost.id)) await testState.closeTab(tab.id);await hopline.hosts.delete(firstUseHost.id);await hopline.settings.update({theme:'light'});await testState.reloadCatalog();testState.patch({snapshots:{},toasts:[]});firstNav.navigate({page:'overview'})")
  await waitFor('testState.getState().hosts.length===0 && testState.getState().tabs.length===0')
  await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].setContentSize(...m4cOriginalSize)')
  fixture.close()
  console.log('PASS bilingual first use, blank name, Save and connect, immediate post-connection collection, persisted check or skip, hidden collection pause, visible scoped collection, needs-attention confirmation, secure connection card and collection preferences')
}

export async function updatesSmoke(context) {
  const { main, evaluate, waitFor, key } = context
  const current = await main.evaluate('testElectron.app.getVersion()')
  const [major, minor] = current.split('.').map(Number)
  const futureVersion = `${major}.${minor + 1}.0`
  const release = { version: futureVersion, url: `https://github.com/dadadasir/HopLine/releases/tag/v${futureVersion}`, summary: '改善连接体验。\nImprove connection reliability.\n<img src=x onerror=alert(1)> [link](http://example.test)' }
  await main.evaluate(`globalThis.m4cUpdateResult=${JSON.stringify({status:'available',release})};globalThis.m4cOpened=[];globalThis.m4cOriginalOpen=testElectron.shell.openExternal;testElectron.shell.openExternal=async url=>{m4cOpened.push(url)};testElectron.ipcMain.removeHandler('updates:check');testElectron.ipcMain.handle('updates:check',()=>m4cUpdateResult)`)
  for (const [theme, locale] of [['light','zh'], ['dark','zh'], ['dark','en']]) {
    await evaluate(`await hopline.settings.update({theme:${JSON.stringify(theme)},language:${JSON.stringify(locale)}});await testState.reloadCatalog()`)
    const label = locale === 'zh' ? '检查更新…' : 'Check for updates…'
    await main.evaluate(`(()=>{const flatten=items=>items.flatMap(item=>[item,...(item.submenu?flatten(item.submenu.items):[])]);flatten(testElectron.Menu.getApplicationMenu().items).find(item=>item.label===${JSON.stringify(label)}).click()})()`)
    await waitFor("document.querySelector('[data-testid=update-summary]')")
    assert.equal(await evaluate("document.querySelector('[data-testid=update-summary]').textContent"), release.summary)
    assert.equal(await evaluate("document.querySelector('[data-testid=update-summary]').querySelectorAll('img,a,script').length"), 0)
    await capture(context, `updates-${theme}-${locale}`)
    const openLabel = locale === 'zh' ? '打开版本页面' : 'Open release page'
    await evaluate(`Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent===${JSON.stringify(openLabel)}).click()`)
    await key('Escape')
  }
  assert.deepEqual(await main.evaluate('m4cOpened'), [release.url,release.url,release.url])
  await evaluate("await hopline.settings.update({language:'zh',theme:'light'});await testState.reloadCatalog();testState.patch({settingsOpen:'appearance',toasts:[]})")
  await waitFor("document.querySelector('[role=dialog] [data-testid=update-settings] input:not(:disabled)')")
  await evaluate("document.querySelector('[role=dialog] [data-testid=update-settings] input').click()")
  await waitFor('testState.getState().updatePreferences?.automatic===false')
  assert.equal(await evaluate('(await hopline.updates.preferences()).automatic'), false)
  await capture(context, 'update-settings-light')
  await key('Escape')
  for (const result of [{status:'current'},{status:'error',reason:'network'},{status:'error',reason:'invalid'}]) {
    await main.evaluate(`m4cUpdateResult=${JSON.stringify(result)}`)
    await evaluate("await (await import('/src/state/updates.ts')).checkForUpdates()")
    await waitFor('!testState.getState().updateChecking')
    assert.equal(await evaluate('testState.getState().updateResult.status'), result.status)
    const text = await evaluate("document.querySelector('[data-testid=update-dialog]').textContent")
    assert.ok(text.includes(result.status==='current'?'当前已是最新正式版本':result.reason==='network'?'无法连接 GitHub':'版本信息异常'))
    await key('Escape')
  }
  await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].webContents.send('updates:available',${JSON.stringify(release)});testElectron.shell.openExternal=m4cOriginalOpen`)
  await waitFor("document.querySelector('[data-testid=update-summary]')")
  await key('Escape')
  console.log('PASS M4-C native update menu, inert notes, guarded release link, manual outcomes, automatic notification and persisted opt-out; no external request/download')
}
