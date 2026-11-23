import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function credentialsUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory }) {
  const capture = async name => {
    await evaluate('document.fonts.ready'); await delay(250)
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(screenshotDirectory, `hopline-credentials-${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64')); console.log(`CAPTURE credentials ${name}: ${file}`)
  }
  const input = async (selector, value) => evaluate(`(()=>{const el=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length);const prototype=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const clickText = async (scope, text) => evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(scope + ' button')})).find(b=>b.getClientRects().length&&b.textContent===${JSON.stringify(text)}).click()`)
  const oldSize = await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].getContentSize()')
  await main.evaluate("globalThis.credentialsCanPrompt=testElectron.systemPreferences.canPromptTouchID;testElectron.systemPreferences.canPromptTouchID=()=>false;globalThis.credentialsClipboardBefore=await testElectron.clipboard.read();globalThis.credentialsCollectHandler=testElectron.ipcMain._invokeHandlers.get('collect:overview');testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',()=>{});testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1440,900);undefined")
  await evaluate("window.credentialsSettings=await hopline.settings.get();window.credentialsHosts=[];testState.patch({settingsOpen:false,confirm:null,toasts:[]});testNav.navigate({page:'activity'});await hopline.settings.update({verifySecrets:false,theme:'light'});for(let i=0;i<3;i++)credentialsHosts.push(await hopline.hosts.save({name:'Credentials '+(i+1),host:'192.0.2.'+(10+i),port:i===0?22:2222,username:'root',groupId:null,authType:'password',password:'fixture-visible-password',...(i===0?{passphrase:'fixture-host-passphrase',proxy:{type:'socks5',host:'127.0.0.1',port:1080,password:'fixture-proxy-password'},jumps:[{host:'127.0.0.1',port:2200,username:'jump',authType:'password',password:'fixture-jump-password'},{host:'127.0.0.1',port:2201,username:'jump',authType:'privateKey',passphrase:'fixture-jump-passphrase'}]}:{})}));window.credentialsGroup=await hopline.groups.save({name:'Credentials order fixture'});credentialsHosts[2]=await hopline.hosts.save({...credentialsHosts[2],groupId:credentialsGroup.id});await testState.reloadCatalog()")
  try {
    for (const locale of ['zh','en']) {
      const zh = locale === 'zh'
      const copy = zh ? '复制密码' : 'Copy password'
      const cardLabel = zh ? '复制连接信息' : 'Copy connection info'
      const cardCopied = zh ? '连接信息已复制，60 秒后清除' : 'Connection info copied. Clears in 60 seconds.'
      const edit = zh ? '编辑连接' : 'Edit connection'
      const saveFirst = zh ? '请先保存' : 'Save first'
      const copied = zh ? '密码已复制，60 秒后清除' : 'Password copied. Clears in 60 seconds.'
      const password = '[role=dialog] input[placeholder="••••••••"]'
      await evaluate(`await hopline.settings.update({language:'${locale}'});await testState.reloadCatalog();testState.patch({toasts:[]});testNav.openHost(credentialsHosts[0].id)`)
      const sshButton = `document.querySelector('section[aria-label="Credentials 1"] [data-ssh-command]')`
      await waitFor(`${sshButton}?.getClientRects().length`)
      const keyButton = `section[aria-label="Credentials 1"] header button[aria-label=${JSON.stringify(cardLabel)}]`
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(keyButton)}).title`), cardLabel)
      const command = await evaluate(`${sshButton}.textContent`)
      assert.equal(command, 'ssh -p 22 root@192.0.2.10')
      await capture(`heading-${locale}`)
      await evaluate(`${sshButton}.click()`)
      await waitFor(`(async()=>await hopline.clipboard.read()===${JSON.stringify(command)})()`)
      await evaluate(`testState.patch({toasts:[]});document.querySelector(${JSON.stringify(keyButton)}).click()`)
      const card = zh ? '名称：Credentials 1\nIP：192.0.2.10\n端口：22\n用户名：root\n密码：fixture-visible-password'
        : 'Name: Credentials 1\nIP: 192.0.2.10\nPort: 22\nUsername: root\nPassword: fixture-visible-password'
      await waitFor(`(async()=>await hopline.clipboard.read()===${JSON.stringify(card)})()`)
      assert.ok(await main.evaluate("(await testElectron.clipboard.read()).some(item=>item.types.includes('electron application/osclipboard;format=\"org.nspasteboard.ConcealedType\"'))"))
      const toastItem = `Array.from(document.querySelectorAll('[data-toast-stack] [role=status]')).find(item=>item.textContent.includes(${JSON.stringify(cardCopied)}))`
      await waitFor(`${toastItem}`)
      assert.equal(await evaluate(`(() => {
        const heading = document.querySelector('section[aria-label="Credentials 1"] > header')
        return ${toastItem}.getBoundingClientRect().top > heading.getBoundingClientRect().bottom
      })()`), true)
      await capture(`heading-toast-${locale}`)
      await evaluate("testState.patch({toasts:[]})")
      await clickText('header', edit)
      const passwordInput = `document.querySelector(${JSON.stringify(password)})`
      await waitFor(`${passwordInput}?.type==='password'`)
      assert.equal(await evaluate(`${passwordInput}.value`), '')
      await capture(`edit-${locale}`)
      const copyButton = `document.querySelector(${JSON.stringify(`[role=dialog] button[aria-label=${JSON.stringify(copy)}]`)})`
      assert.equal(await evaluate(`${copyButton}.disabled`), false)
      await evaluate("await hopline.clipboard.write('fixture-clipboard-before-copy')")
      await input(password, 'fixture-unsaved-password')
      await waitFor(`${copyButton}.disabled`)
      assert.equal(await evaluate(`${copyButton}.parentElement.title`), saveFirst)
      await evaluate(`${copyButton}.click()`)
      assert.equal(await evaluate('await hopline.clipboard.read()'), 'fixture-clipboard-before-copy')
      await capture(`save-first-${locale}`)
      await input(password, '')
      await waitFor(`!${copyButton}.disabled`)
      const eye = `${passwordInput}.parentElement.querySelector('button[aria-pressed]')`
      const revealed = `${passwordInput}?.type==='text'&&${passwordInput}.value==='fixture-visible-password'`
      await evaluate(`${eye}.click()`)
      await waitFor(revealed)
      assert.ok(!(await evaluate('JSON.stringify(testState.getState())')).includes('fixture-visible-password'))
      await capture(`revealed-${locale}`)
      await input(password, 'fixture-unsaved-password')
      await waitFor(`${copyButton}.disabled`)
      await input(password, 'fixture-visible-password')
      await waitFor(`!${copyButton}.disabled`)
      await evaluate(`${eye}.click()`)
      await waitFor(`${passwordInput}.type==='password'&&${passwordInput}.value==='fixture-visible-password'`)
      await evaluate("await hopline.clipboard.write('fixture-clipboard-before-copy')")
      await evaluate(`${copyButton}.click()`)
      await waitFor("(async()=>await hopline.clipboard.read()==='fixture-visible-password')()")
      await waitFor(`testState.getState().toasts.some(item=>item.text===${JSON.stringify(copied)})`)
      assert.equal(await evaluate(`document.querySelector('[data-toast-stack]').getBoundingClientRect().right <= document.querySelector('[data-drawer]').getBoundingClientRect().left`), true)
      await capture(`copied-${locale}`)
      if (zh) {
        await evaluate(`${eye}.click()`)
        await waitFor(revealed)
        await delay(30_100)
        assert.equal(await evaluate(`${passwordInput}.value`), '')
        await evaluate(`${eye}.click()`)
        await waitFor(revealed)
        await main.evaluate("testElectron.BrowserWindow.getAllWindows()[0].webContents.send('hosts:clearRevealed')")
        await waitFor(`${passwordInput}.type==='password'&&${passwordInput}.value===''`)
      }
      const storeFile = JSON.stringify(path.join(await main.evaluate("testElectron.app.getPath('userData')"), 'hopline-store.json'))
      const before = await main.evaluate(`process.getBuiltinModule('fs').readFileSync(${storeFile}, 'utf8')`)
      await evaluate(`${eye}.click()`)
      await waitFor(revealed)
      await evaluate("document.querySelector('[role=dialog] button[type=submit]').click()")
      await waitFor("!testState.getState().hostDialog")
      const after = await main.evaluate(`process.getBuiltinModule('fs').readFileSync(${storeFile}, 'utf8')`)
      const ciphertext = json => JSON.parse(json).hosts.find(host => host.name === 'Credentials 1').passwordEnc
      assert.equal(ciphertext(before), ciphertext(after), 'revealing and saving leaves the exact ciphertext unchanged')
      const advancedFields = [
        ['代理密码', 'fixture-proxy-password'],
        ['跳板 · 密码', 'fixture-jump-password'],
        ['跳板 · 私钥口令', 'fixture-jump-passphrase']
      ]
      await clickText('header', edit)
      await waitFor(`${passwordInput}?.type==='password'&&${passwordInput}.value===''`)
      if (zh) {
        for (const [label, secret] of advancedFields) {
          const field = `Array.from(document.querySelectorAll('[role=dialog] input[placeholder="••••••••"]')).find(input=>Array.from(input.parentElement.querySelectorAll('button')).some(button=>button.getAttribute('aria-label')===${JSON.stringify('显示' + label)}))`
          await evaluate(`${field}.parentElement.querySelector('button[aria-pressed]').click()`)
          await waitFor(`Array.from(document.querySelectorAll('[role=dialog] input[type=text]')).some(input=>input.value===${JSON.stringify(secret)})`)
        }
        await clickText('[role=dialog]', '私钥')
        await waitFor("document.querySelector('[role=dialog] button[aria-label=\"显示私钥口令\"]')")
        await evaluate("document.querySelector('[role=dialog] button[aria-label=\"显示私钥口令\"]').click()")
        await waitFor("Array.from(document.querySelectorAll('[role=dialog] input[type=text]')).some(input=>input.value==='fixture-host-passphrase')")
      }
      await key('Escape')
      await waitFor("!testState.getState().hostDialog")
      await evaluate("testState.patch({toasts:[]})")
      await input('aside input[aria-label]', 'Credentials')
      await evaluate("document.querySelector('aside [data-host-id=\"'+credentialsHosts[2].id+'\"]').click()")
      await waitFor("testState.getState().route.hostId===credentialsHosts[2].id&&document.querySelectorAll('aside [data-host-id][aria-pressed=true]').length===1")
      await evaluate("document.querySelector('aside [data-host-id=\"'+credentialsHosts[1].id+'\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))")
      await waitFor("document.querySelectorAll('aside [data-host-id][aria-pressed=true]').length===3")
      await evaluate("document.querySelector('aside [data-host-id=\"'+credentialsHosts[1].id+'\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))")
      await waitFor("document.querySelectorAll('aside [data-host-id][aria-pressed=true]').length===2")
      await evaluate("document.querySelector('aside [data-host-id=\"'+credentialsHosts[0].id+'\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:180,clientY:270}))")
      const copyLabel = zh ? '复制 SSH 命令（2 台）' : 'Copy SSH commands (2 hosts)'
      const menuItems = "Array.from(document.querySelectorAll('[role=menuitem]')).map(el=>el.textContent)"
      await waitFor(`${menuItems}.includes(${JSON.stringify(copyLabel)})`)
      assert.deepEqual(await evaluate(menuItems), [copyLabel])
      await capture(`multi-menu-${locale}`)
      await evaluate("document.querySelector('[role=menuitem]').click()")
      const expectedBatch = 'ssh -p 2222 root@192.0.2.12\nssh -p 22 root@192.0.2.10'
      await waitFor(`(async()=>await hopline.clipboard.read()===${JSON.stringify(expectedBatch)})()`)
      await evaluate("document.querySelector('aside [data-host-id=\"'+credentialsHosts[0].id+'\"]').click()")
      await waitFor("document.querySelectorAll('aside [data-host-id][aria-pressed=true]').length===1")
      await evaluate("document.querySelector('aside [data-host-id=\"'+credentialsHosts[0].id+'\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:180,clientY:270}))")
      await waitFor(`${menuItems}.length===5`)
      assert.deepEqual(await evaluate(menuItems), zh
        ? ['连接', '编辑', '复制 SSH 命令', '创建副本', '删除']
        : ['Connect', 'Edit', 'Copy SSH command', 'Duplicate', 'Delete'])
      await capture(`single-menu-${locale}`)
      const duplicateLabel = zh ? '创建副本' : 'Duplicate'
      await waitFor(`Array.from(document.querySelectorAll('[role=menuitem]')).some(el=>el.textContent===${JSON.stringify(duplicateLabel)})`)
      await evaluate(`Array.from(document.querySelectorAll('[role=menuitem]')).find(el=>el.textContent===${JSON.stringify(duplicateLabel)}).click()`)
      await waitFor(`testState.getState().toasts.some(item=>item.text===${JSON.stringify(zh ? '已创建副本' : 'Duplicated')})`)
      await evaluate("for(const host of await hopline.hosts.list())if(host.name.startsWith('Credentials')&&!credentialsHosts.some(saved=>saved.id===host.id))await hopline.hosts.delete(host.id);await testState.reloadCatalog()")
      await evaluate("testNav.navigate({page:'settings'})")
      await waitFor("document.querySelector('.workspace-page nav')")
      await clickText('.workspace-page nav', zh ? '外观' : 'Appearance')
      assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-verify-secrets]')).some(el=>el.getClientRects().length)"), false)
      await clickText('.workspace-page nav', zh ? '备份' : 'Backup')
      await waitFor("Array.from(document.querySelectorAll('[data-verify-secrets]')).some(el=>el.getClientRects().length)")
      await evaluate("await hopline.settings.update({verifySecrets:true});await testState.reloadCatalog()")
      await waitFor("Array.from(document.querySelectorAll('[data-verify-secrets]')).find(el=>el.getClientRects().length)?.checked")
      await evaluate("Array.from(document.querySelectorAll('[data-verify-secrets]')).find(el=>el.getClientRects().length).click()")
      await waitFor("(async()=>(await hopline.settings.get()).verifySecrets===false)()")
      await evaluate("testState.patch({hostDialog:'new'})")
      await waitFor("document.querySelector('[role=dialog] form')")
      assert.equal(await evaluate("document.querySelector('[role=dialog] form input[maxlength=\"128\"]').value"), 'root')
      await clickText('[role=dialog]', zh ? '从文本识别' : 'Recognize from text')
      await waitFor("document.querySelector('[data-recognition-text]')")
      await input('[data-recognition-text]', zh ? 'IPv4：192.0.2.99\nIPv6：2001:db8::99\n端口：2200\n用户名：admin\n密码：test-password' : 'IP: 192.0.2.99\nIPv6: 2001:db8::99\nPort: 2200\nUsername: admin\nPassword: test-password')
      await clickText('[role=dialog]', zh ? '识别' : 'Recognize')
      await waitFor("document.querySelectorAll('[data-recognition-address] option:not([disabled])').length===2")
      assert.equal(await evaluate("document.querySelector('[data-recognition-address]').value"), '')
      await evaluate("const select=document.querySelector('[data-recognition-address]');select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}))")
      await clickText('[role=dialog]', zh ? '填入表单' : 'Fill form')
      await waitFor("!document.querySelector('[data-recognition-text]')")
      assert.equal(await evaluate("document.querySelector('[role=dialog] form input[maxlength=\"255\"]').value"),'192.0.2.99')
      assert.equal(await evaluate("document.querySelector('[role=dialog] form input[maxlength=\"128\"]').value"),'admin')
      assert.equal(await evaluate("document.querySelector('[role=dialog] form input[type=password]').value"),'test-password')
      const toggles = await evaluate("Array.from(document.querySelectorAll('[role=dialog] button[aria-label]')).map(el=>el.getAttribute('aria-label'))")
      assert.ok(toggles.some(label=>/显示密码|Show password|Show Password/.test(label)))
      assert.ok(!toggles.includes(copy), 'a new host can reveal its draft and has no saved-password copy action')
      await evaluate("document.querySelector('[role=dialog] form input[type=password]').parentElement.querySelector('button').click()")
      assert.equal(await evaluate("document.querySelector('[role=dialog] form input[autocomplete=off]').type"),'text')
      await key('Escape')
      await waitFor("testState.getState().hostDialog===false")
      await evaluate("testState.patch({hostDialog:'new'})")
      await waitFor("document.querySelector('[role=dialog] form input[maxlength=\"255\"]')")
      await evaluate("(()=>{const data=new DataTransfer();data.setData('text','ssh -p 2223 ubuntu@[2001:db8::42]');document.querySelector('[role=dialog] form input[maxlength=\"255\"]').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}))})()")
      await waitFor("document.querySelector('[role=dialog] form input[maxlength=\"255\"]').value==='2001:db8::42'")
      assert.equal(await evaluate("document.querySelector('[role=dialog] form input[maxlength=\"128\"]').value"),'ubuntu')
      await key('Escape')
    }
    console.log('PASS credentials: bilingual heading and bottom toast; unsaved draft blocks copy and preserves clipboard; reverting enables copy; masking/reveal/saved copy; single/multi menus; unchanged ciphertext on reveal/save; all five fields; concealed clipboard; close, hide and 30-second cleanup; SSH paste and text recognition')
  } finally {
    await evaluate("testState.patch({hostDialog:false});for(const host of credentialsHosts)await hopline.hosts.delete(host.id);await hopline.groups.delete(credentialsGroup.id);await hopline.settings.update({language:credentialsSettings.language,theme:credentialsSettings.theme,verifySecrets:credentialsSettings.verifySecrets});await testState.reloadCatalog();testNav.navigate({page:'overview'})")
    await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].setContentSize(${oldSize[0]},${oldSize[1]});testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',credentialsCollectHandler);if(credentialsClipboardBefore.some(item=>item.types.length))await testElectron.clipboard.write(await Promise.all(credentialsClipboardBefore.filter(item=>item.types.length).map(async item=>new testElectron.ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)])))))));else testElectron.clipboard.clear();credentialsClipboardBefore=undefined;testElectron.systemPreferences.canPromptTouchID=credentialsCanPrompt;undefined`)
  }
}
