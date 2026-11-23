import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** README scenes use fictional data only; no fixture address is ever connected. */
export async function releaseScreenshots({ browser, main, evaluate, waitFor, delay, directory }) {
  fs.mkdirSync(directory, { recursive: true })
  const size = await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].getContentSize()')
  await main.evaluate("globalThis.releaseCollect=testElectron.ipcMain._invokeHandlers.get('collect:overview');testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',()=>{});testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1440,900);undefined")
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate(`window.releaseSettings=await hopline.settings.get();window.releaseHosts=[];window.releaseTabs=testState.getState().tabs;window.releaseActive=testState.getState().activeId;
    const search=document.querySelector('aside input[aria-label]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}));
    window.releaseGroup=await hopline.groups.save({name:'ExampleCloud'});
    window.releaseNow=Date.now();
    const rows=[['web-sg-01','192.0.2.10',22,'USD',1500,'monthly',10],['api-eu-01','198.51.100.20',2202,'EUR',7200,'yearly',45],['backup-us-01','203.0.113.30',22,'CNY',18000,'quarterly',60]];
    for(const[name,host,port,currency,price,billingCycle,days]of rows)releaseHosts.push(await hopline.hosts.save({name,host,port,username:'root',groupId:releaseGroup.id,authType:'password',password:'readme-fixture-password',meta:{provider:'ExampleCloud',currency,price,billingCycle,renewAt:releaseNow+days*86400000}}));
    const complete=data=>({status:'complete',data});
    window.releaseRecords=Object.fromEntries(releaseHosts.map((host,i)=>[host.id,{updatedAt:releaseNow,error:null,snapshot:{collectedAt:releaseNow,
      os:complete({name:'Debian GNU/Linux',id:'debian',version:'13',kernel:'6.12.0-example',architecture:'x86_64'}),uptime:complete({seconds:1728000}),
      cpu:complete({cores:2,usagePercent:[18,32,8][i]}),memory:complete({totalBytes:4294967296,availableBytes:[3006477107,2362232013,3435973837][i],swapTotalBytes:0,swapUsedBytes:0}),
      load:complete({one:0.24,five:0.18,fifteen:0.16}),disk:complete([{filesystem:'/dev/vda1',mountpoint:'/',totalBytes:85899345920,usedBytes:34359738368,availableBytes:51539607552,usagePercent:40}]),
      listeners:complete([{protocol:'tcp',address:'0.0.0.0',port:host.port,process:'sshd'}]),docker:complete([]),services:complete([{name:'ssh',description:'OpenSSH server'}]),web:complete([]),certs:complete([])}}]));
    testState.patch({settingsOpen:false,confirm:null,paletteOpen:false,hostDialog:null,toasts:[],tabs:[],activeId:null})`)
  const capture = async name => {
    await evaluate('testState.patch({toasts:[]});document.fonts.ready'); await delay(450)
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
    assert.equal(await evaluate("document.querySelectorAll('aside [data-host-id]').length"), 3)
    assert.equal(await evaluate("document.querySelector('aside input[aria-label]').value"), '')
    assert.equal(await evaluate("document.body.innerText.includes('readme-fixture-password')"), false)
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(directory, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64')); console.log(`CAPTURE release ${name}: ${file}`)
  }
  try {
    for (const language of ['zh', 'en']) {
      await evaluate(`await hopline.settings.update({language:'${language}',theme:'light',displayCurrency:'auto'});await testState.reloadCatalog();testState.patch({hosts:releaseHosts,groups:[releaseGroup],snapshots:releaseRecords,collecting:[],fx:await hopline.fx.read()});testNav.navigate({page:'overview'})`)
      await waitFor("document.querySelector('[data-billing-cost]')&&document.querySelectorAll('article').length===3")
      await evaluate("Array.from(document.querySelectorAll('button')).find(button=>['跳过','Skip'].includes(button.textContent))?.click()")
      assert.match(await evaluate("document.querySelector('[data-billing-cost]').innerText"), /[¥$]/)
      await capture(`overview-${language}`)
      await evaluate("document.querySelector('[data-billing-cost]').click()")
      await waitFor("document.querySelectorAll('[data-billing-host]').length===3")
      await capture(`billing-${language}`)
      await evaluate('testNav.openHost(releaseHosts[0].id)')
      await waitFor("Array.from(document.querySelectorAll('[data-ssh-command]')).some(button=>button.getClientRects().length)")
      const commandButton = "Array.from(document.querySelectorAll('[data-ssh-command]')).find(button=>button.getClientRects().length)"
      const pointer = await evaluate(`(() => { const box = ${commandButton}.getBoundingClientRect(); return { x: box.x + 12, y: box.y + box.height / 2 } })()`)
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointer })
      await capture(`host-heading-${language}`)
      await evaluate(`Array.from(document.querySelectorAll('header button')).find(button=>button.getClientRects().length&&button.textContent===${JSON.stringify(language === 'zh' ? '编辑连接' : 'Edit connection')}).click()`)
      await waitFor("document.querySelector('[role=dialog] input[placeholder=\"••••••••\"]')?.type==='password'")
      assert.equal(await evaluate("document.querySelector('[role=dialog] input[placeholder=\"••••••••\"]').value"), '')
      await capture(`host-edit-${language}`)
      await evaluate("testState.patch({hostDialog:false})")
    }
  } finally {
    await evaluate("for(const host of releaseHosts)await hopline.hosts.delete(host.id);await hopline.groups.delete(releaseGroup.id);await hopline.settings.update({language:releaseSettings.language,theme:releaseSettings.theme,displayCurrency:releaseSettings.displayCurrency});await testState.reloadCatalog();testState.patch({tabs:releaseTabs,activeId:releaseActive,hostDialog:false});testNav.navigate({page:'overview'})")
    await main.evaluate(`testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',releaseCollect);testElectron.BrowserWindow.getAllWindows()[0].setContentSize(${size[0]},${size[1]});undefined`)
  }
  console.log('PASS eight bilingual README images: synthetic overview, billing, host heading and masked connection editor')
}
