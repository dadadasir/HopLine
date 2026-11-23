import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/** Deterministic overview visuals in the smoke runner's temporary profile. */
export async function overviewLimitSmoke({ browser, main, evaluate, waitFor, click, screenshotDirectory, delay, first }) {
  // Compare settled UI geometry, not the subpixel phase of gauge animations.
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  const baseline = process.env.HOPLINE_OVERVIEW_BASELINE === '1'
  const baselineDirectory = process.env.HOPLINE_OVERVIEW_BASELINE_DIR
  await evaluate("testState.patch({securityHost:null,toasts:[]});await hopline.collect.overview(false)")
  // Freeze automatic publication only for these static visual fixtures. The
  // scheduler and real manual collection have separate integration coverage.
  await main.evaluate("testElectron.ipcMain.removeHandler('collect:overview');testElectron.ipcMain.handle('collect:overview',()=>{});undefined")
  await evaluate(`window.m4OriginalNow=Date.now;window.m4Now=Date.now();Date.now=()=>m4Now;
    window.m4Record={snapshot:{...extraSnapshot,collectedAt:Date.now(),securityScore:100,
      uptime:{status:'complete',data:{seconds:172800}},cpu:{status:'complete',data:{cores:2,usagePercent:18}},
      memory:{status:'complete',data:{totalBytes:2147483648,availableBytes:1610612736,swapTotalBytes:0,swapUsedBytes:0}},
      load:{status:'complete',data:{one:0.2,five:0.1,fifteen:0.1}},
      disk:{status:'complete',data:[{filesystem:'/dev/vda1',mountpoint:'/',totalBytes:42949672960,usedBytes:17179869184,availableBytes:25769803776,usagePercent:40}]}},updatedAt:Date.now(),error:null};
    window.m4Hosts=Array.from({length:8},(_,i)=>({...fileHost,id:'m4-'+i,name:'总览主机 '+String(i+1).padStart(2,'0'),host:'127.0.0.'+(i+1),port:22,username:'test',meta:{...fileHost.meta,price:1000,currency:'USD',billingCycle:'monthly',renewAt:i>=5?Date.now()+14*86400000:null}}));
    testNav.navigate({page:'sessions'})`)
  const capture = async (name, compare = false) => {
    await delay(650)
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('section[aria-label=总览],section[aria-label=Overview]')].every(el=>el.scrollWidth<=el.clientWidth)"), true)
    const location = path.join(screenshotDirectory, `hopline-m4-a-${name}.png`)
    const full = await browser.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(location, Buffer.from(full.data, 'base64'))
    if (compare) {
      const clip = await evaluate("(()=>{const r=document.querySelector('section[aria-label=总览]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()")
      const region = await browser.send('Page.captureScreenshot', { format: 'png', clip })
      const regionPath = path.join(screenshotDirectory, `hopline-m4-a-${name}-region.png`)
      fs.writeFileSync(regionPath, Buffer.from(region.data, 'base64'))
      if (!baseline && baselineDirectory) {
        const reference = path.join(baselineDirectory, path.basename(regionPath))
        assert.ok(fs.existsSync(reference), `Missing before-change reference: ${reference}`)
        assert.equal(await main.evaluate(`testElectron.nativeImage.createFromPath(${JSON.stringify(reference)}).toBitmap().equals(testElectron.nativeImage.createFromPath(${JSON.stringify(regionPath)}).toBitmap())`), true, `Unchanged overview pixels: ${name}`)
      }
    }
    console.log(`CAPTURE M4-A 1024x700 ${name}: ${location}`)
  }
  for (const count of [1, 5]) for (const theme of ['light', 'dark']) {
    await evaluate(`await hopline.settings.update({language:'zh',theme:${JSON.stringify(theme)}});await testState.reloadCatalog();testNav.navigate({page:'sessions'});
      testState.patch({hosts:m4Hosts.slice(0,${count}),snapshots:Object.fromEntries(m4Hosts.slice(0,${count}).map(h=>[h.id,structuredClone(m4Record)])),collecting:[],toasts:[]});testNav.navigate({page:'overview'})`)
    await waitFor("document.querySelector('section[aria-label=总览] article')")
    assert.equal(await evaluate("document.querySelectorAll('section[aria-label=总览] article').length"), count)
    assert.equal(await evaluate("document.querySelector('section[aria-label=总览]').innerText.includes('专业版即将推出')"), false)
    await capture(`${count}-${theme}`, true)
    if (count === 5) {
      await evaluate("(()=>{const area=document.querySelector('section[aria-label=总览]');area.scrollTop=area.scrollHeight})()")
      await capture(`${count}-${theme}-bottom`, true)
    }
  }
  if (!baseline) {
    // The sixth visual card points at the existing authorized loopback host so
    // its detail refresh uses the real bridge, service, pool and SSH transport.
    await evaluate("m4Hosts[5]={...m4Hosts[5],id:fileHost.id,host:fileHost.host,port:fileHost.port}")
    const arrange = async (count, theme, language = 'zh') => {
      await evaluate(`await hopline.settings.update({language:${JSON.stringify(language)},theme:${JSON.stringify(theme)}});await testState.reloadCatalog();testNav.navigate({page:'sessions'});
        testState.patch({hosts:m4Hosts.slice(0,${count}),snapshots:Object.fromEntries(m4Hosts.slice(0,${count}).map(h=>[h.id,structuredClone(m4Record)])),collecting:[],toasts:[]});testNav.navigate({page:'overview'})`)
      await waitFor('document.querySelector("[data-overview-limited]")')
      await evaluate("document.querySelector('[data-overview-limited]').closest('section[aria-label]').scrollTop=0")
    }
    for (const count of [6, 8]) for (const theme of ['light', 'dark']) {
      await arrange(count, theme)
      assert.equal(await evaluate("document.querySelectorAll('section[aria-label=总览] article').length"), 5)
      assert.equal(await evaluate("document.querySelectorAll('[data-overview-limited-host]').length"), count - 5)
      assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('[data-overview-limited-host]')).map(el=>el.textContent)"), await evaluate(`m4Hosts.slice(5,${count}).map(h=>h.name+h.host+(h.port===22?'':':'+h.port))`))
      assert.equal(await evaluate("document.querySelectorAll('[data-overview-limited] article,[data-overview-limited] svg,[data-overview-limit-note] a,[data-overview-limit-note] button').length"), 0)
      assert.ok(await evaluate("getComputedStyle(document.querySelector('[data-overview-limited]')).maskImage.includes('linear-gradient')"))
      assert.ok(await evaluate("document.querySelector('section[aria-label=总览]').innerText.includes('5/5')"))
      if (count === 8) await capture(`${count}-${theme}-top`)
      await evaluate("document.querySelector('[data-overview-limit-note]').scrollIntoView({block:'end'})")
      await capture(`${count}-${theme}-limited`)
    }
    await arrange(8, 'dark', 'en')
    assert.ok(await evaluate("document.querySelector('[data-overview-limit-note]').innerText.includes('Overview automatically updates the first 5 hosts.')"))
    await evaluate("document.querySelector('[data-overview-limit-note]').scrollIntoView({block:'end'})")
    await capture('8-dark-limited-en')

    await arrange(8, 'light')
    await evaluate("document.querySelector('[data-overview-limited-host=\"'+fileHost.id+'\"]').scrollIntoView({block:'center'})")
    await click(`[data-overview-limited-host="${await evaluate('fileHost.id')}"]`)
    await waitFor("testState.getState().route.page==='host' && testState.getState().route.hostId===fileHost.id")
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('nav[aria-label=主机功能] button')).map(b=>b.textContent)"), ['状态','安全','维护','文件','资产'])
    assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='打开终端').disabled"), false)
    first.cleanup.enabled = true
    const beforeReads = first.cleanup.collectReads
    await evaluate("Array.from(document.querySelectorAll('section[aria-label=\"总览主机 06\"] button')).find(b=>b.textContent==='刷新').click()")
    // Editing connection settings earlier in the suite retires the old pool
    // entry. A fresh loopback connection may need its interactive password.
    await waitFor("testState.getState().snapshots[fileHost.id]?.updatedAt!==m4Record.updatedAt || (testState.getState().prompts[0]?.kind==='keyboard' && document.querySelector('#kbd-form input'))")
    if (await evaluate("testState.getState().prompts[0]?.kind==='keyboard'")) {
      await evaluate("(()=>{const input=document.querySelector('#kbd-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'smoke-secret');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
      await evaluate("document.querySelector('#kbd-form').requestSubmit()")
    }
    await waitFor("testState.getState().snapshots[fileHost.id]?.updatedAt!==m4Record.updatedAt && testState.getState().snapshots[fileHost.id]?.snapshot?.disk?.status==='complete' && !testState.getState().collecting.includes(fileHost.id)")
    assert.ok(first.cleanup.collectReads > beforeReads)
    assert.equal(await evaluate("testState.getState().snapshots[fileHost.id].error"), null)
    first.cleanup.enabled = false

    // Capture only requested IDs for a click of the overview refresh control;
    // these unsaved visual fixture hosts must never connect to any endpoint.
    await main.evaluate("globalThis.m4Requested=[];testElectron.ipcMain.removeHandler('collect:run');testElectron.ipcMain.handle('collect:run',(_event,id)=>{m4Requested.push(id);return null});undefined")
    await arrange(8, 'light')
    await evaluate("document.querySelector('section[aria-label=总览] > header button').click()")
    await waitFor('testState.getState().collecting.length===0')
    assert.deepEqual(await main.evaluate('m4Requested'), await evaluate('m4Hosts.slice(0,5).map(h=>h.id)'))
    console.log('PASS M4-A limited cards remain clickable, sixth-host detail refresh uses real loopback SSH, and overview refresh requests only the first five')
  }
  await evaluate('Date.now=m4OriginalNow')
  console.log(`PASS M4-A ${baseline ? 'before-change' : 'unchanged'} 1/5-host overview visuals`)
}
