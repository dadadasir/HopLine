import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function readinessUiSmoke({ browser, main, evaluate, waitFor, key, delay, screenshotDirectory }) {
  const capture = async name => {
    await delay(450)
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(screenshotDirectory, `hopline-readiness-${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`CAPTURE readiness ${name}: ${file}`)
  }
  await main.evaluate(`globalThis.readinessOriginalSize=testElectron.BrowserWindow.getAllWindows()[0].getContentSize();testElectron.BrowserWindow.getAllWindows()[0].setContentSize(1024,700);
    globalThis.readinessEditHandler=testElectron.ipcMain._invokeHandlers.get('sftp:edit');globalThis.readinessEdits=0;
    testElectron.ipcMain.removeHandler('sftp:edit');testElectron.ipcMain.handle('sftp:edit',()=>{readinessEdits++;return {localPath:'/temporary-test-editor'}});undefined`)
  try {
    await evaluate("window.readinessUI=await import('/src/components/SftpPanel.tsx');window.readinessTranslate=(await import('/src/i18n.ts')).translate;await hopline.settings.update({s3:{endpoint:'https://s3.example.test',bucket:'preserved-bucket',region:'auto',accessKeyId:'fixture',prefix:'hopline',forcePathStyle:true}});await testState.reloadCatalog()")
    for (const [theme, locale] of [['light','zh'],['dark','zh'],['dark','en']]) {
      await evaluate(`await hopline.settings.update({theme:'${theme}',language:'${locale}'});await testState.reloadCatalog();testState.patch({settingsOpen:'backup',toasts:[]})`)
      await waitFor("document.querySelector('[role=dialog] [data-backup-scope]')")
      const scopeExcluded = locale === 'zh' ? '不包含：命令片段' : 'Excludes snippets'
      assert.equal(await evaluate("document.querySelector('[role=dialog] [data-backup-scope]').open"), false)
      assert.equal(await evaluate(`document.querySelector('[role=dialog]').innerText.includes(${JSON.stringify(scopeExcluded)})`), false)
      await evaluate("document.querySelector('[role=dialog] [data-backup-scope] summary').focus()")
      assert.equal(await evaluate("document.activeElement === document.querySelector('[role=dialog] [data-backup-scope] summary')"), true)
      await key('Enter')
      await waitFor(`document.querySelector('[role=dialog] [data-backup-scope]').open && document.querySelector('[role=dialog]').innerText.includes(${JSON.stringify(scopeExcluded)})`)
      assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog] input')].some(el=>el.value==='preserved-bucket')"), false)
      assert.equal(await evaluate("(await hopline.settings.get()).backup.s3.bucket"), 'preserved-bucket')
      await capture(`backup-scope-${theme}-${locale}`)
      await evaluate("document.querySelector('[role=dialog] [data-backup-s3-note]').scrollIntoView({block:'center'})")
      await waitFor("(()=>{const box=document.querySelector('[role=dialog] [data-backup-s3-note]').getBoundingClientRect();return box.width>0&&box.height>0&&box.top>=0&&box.bottom<=innerHeight})()")
      await capture(`backup-services-${theme}-${locale}`)
      await key('Escape')
      await evaluate(`readinessUI.requestEdit('fixture-session','/etc/example.conf',(key,vars)=>readinessTranslate('${locale}',key,vars))`)
      await waitFor("testState.getState().confirm")
      await waitFor("document.querySelector('[role=dialog]')")
      assert.equal(await evaluate("document.querySelector('[role=dialog] details').open"), false)
      const visibleWarning = await evaluate("document.querySelector('[role=dialog]').innerText")
      assert.ok(visibleWarning.includes('/etc/example.conf'))
      assert.ok(visibleWarning.includes(locale === 'zh' ? '备份重要配置' : 'Back up important configuration'))
      assert.ok(!visibleWarning.includes('Python 3'))
      await capture(`edit-confirm-closed-${theme}-${locale}`)
      await evaluate("document.querySelector('[role=dialog] details summary').focus()")
      await key('Enter')
      await waitFor("document.querySelector('[role=dialog] details').open")
      const editNotice = await evaluate("document.querySelector('[role=dialog]').innerText")
      assert.ok(editNotice.includes(locale === 'zh' ? '原子替换' : 'atomically replaces'))
      assert.ok(editNotice.includes('Python 3'))
      assert.ok(await evaluate("(()=>{const box=document.querySelector('[role=dialog]').getBoundingClientRect();return box.width>0&&box.height>0&&box.top>=0&&box.bottom<=innerHeight})()"))
      await capture(`edit-confirm-${theme}-${locale}`)
      await key('Escape')
      assert.equal(await main.evaluate('readinessEdits'), 0, 'Cancel must not invoke remote editing')
    }
    await evaluate("readinessUI.requestEdit('fixture-session','/etc/example.conf',(key,vars)=>readinessTranslate('en',key,vars))")
    await waitFor("document.querySelector('[role=dialog] button[data-confirm-danger]')")
    await evaluate("document.querySelector('[role=dialog] button[data-confirm-danger]').click()")
    await waitFor('testState.getState().confirm===null')
    assert.equal(await main.evaluate('readinessEdits'), 1)
    assert.equal(await evaluate("(await hopline.settings.get()).backup.s3.bucket"), 'preserved-bucket')
  } finally {
    await main.evaluate("testElectron.ipcMain.removeHandler('sftp:edit');testElectron.ipcMain.handle('sftp:edit',readinessEditHandler);testElectron.BrowserWindow.getAllWindows()[0].setContentSize(...readinessOriginalSize);undefined")
    await evaluate("testState.patch({settingsOpen:false,confirm:null,toasts:[]});await hopline.settings.update({s3:null,language:'zh',theme:'light'});await testState.reloadCatalog()")
  }
  console.log('PASS readiness real UI: backup scope, hidden S3 inputs with retained settings, remote-edit cancellation and explicit confirmation in Chinese/English; edit IPC is a test double')
}
