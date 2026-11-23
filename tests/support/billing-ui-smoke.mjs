import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function billingUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory }) {
  const capture = async name => {
    await evaluate('document.fonts.ready'); await delay(450)
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(screenshotDirectory, `hopline-billing-simple-${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64')); console.log(`CAPTURE simple billing ${name}: ${file}`)
  }
  const setInput = async (selector, value) => evaluate(`(() => { const el=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el=>el.getClientRects().length);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  const originalSize = await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].getContentSize()')
  await main.evaluate('testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1440,900)')
  await evaluate("testState.patch({settingsOpen:false,confirm:null,toasts:[]});testNav.navigate({page:'activity'});window.billingOriginalSettings=await hopline.settings.get();window.billingOriginalFx=testState.getState().fx;window.billingHosts=[]")
  await main.evaluate("globalThis.billingCollectHandler=testElectron.ipcMain._invokeHandlers.get('collect:overview');testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',()=>{});undefined")
  try {
    await evaluate(`const midnight=new Date();midnight.setHours(0,0,0,0);
      const fixtures=[['USD',10000,'monthly',-90],['EUR',12000,'yearly',0],['CNY',3000,'quarterly',15],['JPY',150000,'monthly',16],['KHR',50000,'monthly',null],['USD',10000,'quarterly',null],['CNY',1500,'monthly',null],['CNY',1000,'monthly',null]];
      for(let i=0;i<fixtures.length;i++){const[currency,price,billingCycle,days]=fixtures[i];billingHosts.push(await hopline.hosts.save({groupId:null,name:'Billing '+String(i+1).padStart(2,'0'),host:'127.0.0.1',port:1,username:'fixture',authType:'password',meta:{provider:'ExampleCloud',currency,price,billingCycle,renewAt:days===null?null:midnight.getTime()+days*86400000}}))}
      // Display-only legacy fixture; actual legacy Vault writes are covered in billing.test.ts.
      billingHosts[7].meta.currency=null;billingHosts[7].meta.billingCycle=null`)
    for (const locale of ['zh', 'en']) {
      const zh = locale === 'zh'
      await evaluate(`await hopline.settings.update({language:'${locale}',theme:'light',displayCurrency:'auto'});await testState.reloadCatalog();testState.patch({hosts:billingHosts,fx:await hopline.fx.read(),toasts:[]});testNav.navigate({page:'overview'})`)
      await waitFor('document.querySelector("[data-billing-cost]")')
      const text = await evaluate("document.querySelector('[data-billing-cost]').innerText")
      assert.ok(!/查看详情|View details/.test(text))
      assert.ok(text.includes('$') && text.includes('¥'))
      assert.ok(!/\/\s*(月|month)/.test(text))
      assert.ok(!/≈|2026-11-18|汇率|ECB|未换算|unconverted|rates/.test(text))
      assert.equal(await evaluate("Boolean(document.querySelector('[data-nav=billing]'))"), false)
      assert.equal(await evaluate("document.querySelector('[data-billing-cost]').className.includes('hover:')"), false)
      await capture(`overview-${locale}`)
      await evaluate("document.querySelector('[data-billing-cost]').click()")
      await waitFor('document.querySelector("[data-billing-table]")')
      assert.equal(await evaluate("document.querySelectorAll('[data-billing-host]').length"), 8)
      assert.equal(await evaluate("document.querySelectorAll('[data-billing-table] th').length"), 6)
      assert.equal(await evaluate("document.querySelector('[data-nav=overview]').getAttribute('aria-current')"), 'page')
      assert.ok(await evaluate(`document.querySelector('[data-billing-summary]').textContent.includes(${JSON.stringify(zh ? '不含 1 项' : 'Excludes 1 item')})`))
      const todayText = await evaluate("document.querySelector('[data-billing-host=\"'+billingHosts[1].id+'\"]').innerText")
      assert.ok(todayText.includes(zh ? '今天续费' : 'Renews today'))
      assert.ok(!todayText.includes(zh ? '已逾期' : 'Overdue'))
      assert.ok(await evaluate("document.querySelector('[data-billing-host=\"'+billingHosts[4].id+'\"]').innerText.includes('500.00')"))
      assert.ok(await evaluate(`document.querySelector('[data-billing-host=\"'+billingHosts[7].id+'\"]').innerText.includes(${JSON.stringify(zh ? '信息不完整' : 'Incomplete details')})`))
      assert.ok(!/≈|2026-11-18|ECB|汇率|原币种月费|Monthly \(original\)/.test(await evaluate("document.querySelector('[data-billing-table]').innerText+document.querySelector('[data-billing-summary]').innerText")))
      await capture(`page-${locale}`)
      await evaluate("document.querySelector('select[aria-label]').value='amount';document.querySelector('select[aria-label]').dispatchEvent(new Event('change',{bubbles:true}))")
      await waitFor("document.querySelector('[data-billing-table] tbody tr').textContent.includes('Billing 01')")
      await evaluate(`Array.from(document.querySelectorAll('[data-billing-table] button')).find(b=>b.textContent===${JSON.stringify(zh ? '信息不完整' : 'Incomplete details')}).click()`)
      await waitFor("Array.from(document.querySelectorAll('[data-asset-field=currency]')).some(el=>el.getClientRects().length&&el.value==='')")
      await evaluate("testNav.navigate({page:'overview'});testState.patch({hosts:billingHosts})")
      await waitFor("document.querySelector('[data-billing-cost]')")
      await evaluate("document.querySelector('[data-billing-cost]').click()")
      await waitFor("document.querySelector('[data-billing-table]')")
      await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(zh ? '返回总览' : 'Back to overview')})).click()`)
      await waitFor("document.querySelector('[data-billing-cost]')")
      await evaluate("testNav.navigate({page:'settings'})")
      await waitFor("document.querySelector('.workspace-page nav')")
      await evaluate(`Array.from(document.querySelectorAll('.workspace-page nav button')).find(b=>b.textContent===${JSON.stringify(zh ? '外观' : 'Appearance')}).click()`)
      await waitFor("document.querySelector('[data-display-currency] button')")
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[data-display-currency] button')).map(o=>o.dataset.value)"), ['auto','CNY','USD'])
      assert.ok(!/汇率|exchange rates|manual rates/i.test(await evaluate("document.querySelector('.workspace-page').innerText")))
      await capture(`settings-${locale}`)
      const opposite = zh ? 'USD' : 'CNY'
      await evaluate(`document.querySelector('[data-display-currency] button[data-value=${opposite}]').click()`)
      await waitFor(`(async()=>(await hopline.settings.get()).displayCurrency==='${opposite}')()`)
      await evaluate("testState.patch({hosts:billingHosts});testNav.navigate({page:'overview'})")
      await waitFor("document.querySelector('[data-billing-cost]')")
      assert.ok(await evaluate(`document.querySelector('[data-billing-cost] p:nth-child(2)').textContent.includes('${zh ? '$' : '¥'}')`))
    }
    await evaluate("await hopline.settings.update({language:'zh',displayCurrency:'auto'});await testState.reloadCatalog();testState.patch({hosts:billingHosts});testNav.openHost(billingHosts[0].id,'assets')")
    await waitFor("Array.from(document.querySelectorAll('[data-asset-field=currency]')).some(el=>el.getClientRects().length)")
    await evaluate("window.billingAsset=()=>Array.from(document.querySelectorAll('form')).find(el=>el.querySelector('[data-asset-field=currency]')&&el.getClientRects().length);undefined")
    assert.ok(await evaluate("(async()=>{const h=(await hopline.hosts.list()).find(h=>h.id===billingHosts[0].id);return h.meta.renewAt<new Date().setHours(0,0,0,0)})()"))
    await setInput('[data-asset-field=currency]', '')
    await evaluate("billingAsset().requestSubmit()")
    await waitFor("billingAsset().querySelector('[role=alert]')?.textContent.includes('同时填写币种和计费周期')")
    await setInput('[data-asset-field=currency]', 'rmb')
    await evaluate("billingAsset().requestSubmit()")
    await waitFor("(async()=>(await hopline.hosts.list()).find(h=>h.id===billingHosts[0].id).meta.currency==='CNY')()")
    assert.match(await evaluate("billingAsset().querySelector('[data-asset-monthly]').innerText"), /^月费 ¥[\d,.]+（\$[\d,.]+）$/)
    await capture('asset-zh')
    assert.equal(await evaluate("Boolean(billingAsset().querySelector('[data-renewal-suggestion]'))"), false)
    assert.ok(await evaluate("(async()=>{const h=(await hopline.hosts.list()).find(h=>h.id===billingHosts[0].id);return h.meta.renewAt>=new Date().setHours(0,0,0,0)})()"))
    assert.equal(await evaluate("typeof hopline.fx.refresh"), 'undefined')
    console.log('PASS simple billing: default FX, all eight hosts, six columns, no extra rate UI, bilingual overview/page/settings, matching cards, primary/secondary swap, incomplete asset link, derived renewal saved only with the form')
  } finally {
    await main.evaluate(`testElectron.BrowserWindow.getAllWindows()[0].setContentSize(${originalSize[0]},${originalSize[1]});testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',billingCollectHandler);undefined`)
    await evaluate("for(const host of billingHosts)await hopline.hosts.delete(host.id);await hopline.settings.update({language:billingOriginalSettings.language,theme:billingOriginalSettings.theme,displayCurrency:billingOriginalSettings.displayCurrency});await testState.reloadCatalog();testState.patch({settingsOpen:false,confirm:null,fx:billingOriginalFx});testNav.navigate({page:'overview'})")
  }
}
