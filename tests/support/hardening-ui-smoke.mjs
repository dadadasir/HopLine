import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function hardeningUiSmoke({ browser, main, evaluate, waitFor, delay, screenshotDirectory }) {
  const capture = async name => {
    await delay(450)
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(screenshotDirectory, `hopline-hardening-${name}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`CAPTURE hardening ${name}: ${file}`)
  }
  for (const theme of ['light', 'dark']) {
    await evaluate(`await hopline.settings.update({language:'zh',theme:${JSON.stringify(theme)}});await testState.reloadCatalog();testNav.navigate({page:'sessions'});
      window.staleRecord={...m4Record,updatedAt:Date.now()-7*86400000,snapshot:{...m4Record.snapshot,collectedAt:Date.now()-7*86400000}};
      testState.patch({hosts:[fileHost],snapshots:{[fileHost.id]:staleRecord},collecting:[],toasts:[]});testNav.navigate({page:'overview'})`)
    await waitFor("document.querySelector('article [data-snapshot-stale]')")
    assert.equal(await evaluate("document.querySelectorAll('article .gauge-bar').length"), 3)
    assert.ok(await evaluate("document.querySelector('article').innerText.includes('分钟前更新')"))
    assert.equal(await evaluate("document.querySelector('article').innerText.includes('运行正常')"), false)
    assert.equal(await evaluate("document.querySelector('section[aria-label=服务器总览] h1')?.textContent ?? document.querySelector('section[aria-label] h1')?.textContent"), '1 台待更新')
    await capture(`stale-overview-${theme}`)
    await evaluate("testNav.openHost(fileHost.id,'status')")
    await waitFor("document.querySelector('header [data-snapshot-stale]')")
    assert.ok(await evaluate("document.querySelector('header [data-snapshot-stale]').innerText.includes('分钟前更新')"))
    await capture(`stale-host-${theme}`)
    await evaluate("testState.patch({snapshots:{[fileHost.id]:{...staleRecord,updatedAt:Date.now(),snapshot:{...staleRecord.snapshot,collectedAt:Date.now()}}}})")
    await waitFor("!document.querySelector('[data-snapshot-stale]')")
  }
  // Keep the real preload/IPC/service/cancellation path, replacing only the
  // network boundary. No request reaches an external WebDAV account.
  await main.evaluate(`globalThis.hardeningFetch=globalThis.fetch;globalThis.hardeningRequests=0;globalThis.hardeningAborts=0;
    globalThis.fetch=(_url,init)=>new Promise((_resolve,reject)=>{hardeningRequests++;const cancel=()=>{hardeningAborts++;reject(init.signal.reason)};if(init.signal.aborted)cancel();else init.signal.addEventListener('abort',cancel,{once:true})});undefined`)
  try {
    await evaluate("await hopline.settings.update({webdav:{url:'https://backup.example.test',username:'fixture',password:'webdav-smoke-private',remoteDir:'hopline'}});await testState.reloadCatalog();testState.patch({settingsOpen:'backup',toasts:[]})")
    await waitFor("document.querySelector('[role=dialog] [data-webdav-pull] button')")
    await evaluate("document.querySelector('[role=dialog] [data-webdav-pull] button').click()")
    await waitFor("document.querySelector('[role=dialog] [data-webdav-progress]')")
    for (let i = 0; i < 50 && !(await main.evaluate('hardeningRequests')); i++) await delay(20)
    assert.equal(await main.evaluate('hardeningRequests'), 1)
    assert.ok(await evaluate("[...document.querySelectorAll('[role=dialog] [data-webdav-push] button,[role=dialog] [data-webdav-pull] button')].every(el=>el.disabled)"))
    const busy = await evaluate("await hopline.backup.webdav('pull',null,'merge',crypto.randomUUID()).then(()=>'',e=>e.message)")
    assert.match(busy, /backup.webdavBusy/)
    await evaluate("document.querySelector('[role=dialog] [data-webdav-progress]').scrollIntoView({block:'center'})")
    await capture('webdav-running')
    await evaluate("document.querySelector('[role=dialog] [data-webdav-cancel] button').click()")
    await waitFor("document.querySelector('[role=dialog] [data-backup-error]')?.innerText==='备份同步已取消。'")
    assert.equal(await main.evaluate('hardeningAborts'), 1)
    assert.ok(await evaluate("!document.querySelector('[role=dialog] [data-webdav-pull] button').disabled"))
    assert.ok(await evaluate("!testState.getState().toasts.some(t=>/导入成功|备份完成/.test(t.text))"))
    await capture('webdav-canceled')
    await evaluate("document.querySelector('[role=dialog] [data-webdav-pull] button').click()")
    for (let i = 0; i < 50 && (await main.evaluate('hardeningRequests')) < 2; i++) await delay(20)
    await evaluate("testState.patch({settingsOpen:false})")
    for (let i = 0; i < 50 && (await main.evaluate('hardeningAborts')) < 2; i++) await delay(20)
    assert.equal(await main.evaluate('hardeningAborts'), 2, 'Closing settings cancels its active request')
    await main.evaluate("globalThis.fetch=async()=>new Response('',{status:207,headers:{'content-length':'1048577'}});undefined")
    await evaluate("testState.patch({settingsOpen:'backup'})")
    await waitFor("document.querySelector('[role=dialog] [data-webdav-pull] button')")
    await evaluate("document.querySelector('[role=dialog] [data-webdav-pull] button').click()")
    await waitFor("document.querySelector('[role=dialog] [data-backup-error]')?.innerText.includes('超过 1 MiB')")
    await evaluate("document.querySelector('[role=dialog] [data-backup-error]').scrollIntoView({block:'center'})")
    await capture('webdav-size-limit')
  } finally {
    await main.evaluate('globalThis.fetch=hardeningFetch;delete globalThis.hardeningFetch;undefined')
    await evaluate("testState.patch({settingsOpen:false});await hopline.settings.update({webdav:null});await testState.reloadCatalog()")
  }
  console.log('PASS stale snapshot labels, fresh recovery, WebDAV duplicate guard, explicit cancel, unmount cancel and translated size limit')
}
