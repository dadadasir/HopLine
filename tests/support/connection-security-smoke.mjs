import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

async function capture({ browser, evaluate, delay, screenshotDirectory }, name) {
  await delay(550)
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('[role=dialog],section[aria-label]')].every(el=>el.scrollWidth<=el.clientWidth)"), true)
  const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(screenshotDirectory, `hopline-m4-b-${name}.png`)
  fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64'))
  console.log(`CAPTURE M4-B 1024x700 ${name}: ${file}`)
}

export async function connectionSettingsSmoke(context) {
  const { evaluate, waitFor, key } = context
  const input = (name, value) => evaluate(`(()=>{const el=document.querySelector('[role=dialog] input[name=${name}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const open = async () => {
    await evaluate("testState.patch({hostDialog:testState.getState().hosts.find(h=>h.id===fileHost.id),toasts:[]})")
    await waitFor("document.querySelector('[role=dialog] input[name=connectionTimeoutSec]')")
  }
  const save = async () => {
    await evaluate("document.querySelector('[role=dialog] button[type=submit]').click()")
  }
  await evaluate("await hopline.settings.update({language:'zh',theme:'light'});await testState.reloadCatalog();window.m4bOriginalHost=testState.getState().hosts.find(h=>h.id===fileHost.id);window.m4bTabs=testState.getState().tabs.map(t=>t.id)")
  await open()
  assert.equal(await evaluate("document.querySelector('[name=connectionTimeoutSec]').value"), '')
  assert.equal(await evaluate("document.querySelector('[name=keepaliveIntervalSec]').value"), '')
  await evaluate("document.querySelector('[role=dialog] button[aria-expanded]').click()")
  for (const [field, value, message] of [
    ['connectionTimeoutSec', '4', '连接超时必须是 5 到 120 秒的整数'],
    ['connectionTimeoutSec', '121', '连接超时必须是 5 到 120 秒的整数'],
    ['keepaliveIntervalSec', '301', '心跳间隔必须是 0 到 300 秒的整数'],
    ['keepaliveIntervalSec', '-1', '心跳间隔必须是 0 到 300 秒的整数']
  ]) {
    await input('connectionTimeoutSec', '7'); await input('keepaliveIntervalSec', '0')
    await input(field, value); await save()
    await waitFor(`document.querySelector('[role=dialog] [role=alert]')?.textContent===${JSON.stringify(message)}`)
    assert.equal(await evaluate("testState.getState().hosts.find(h=>h.id===fileHost.id).connectionTimeoutSec"), null)
    assert.equal(await evaluate("testState.getState().hosts.find(h=>h.id===fileHost.id).keepaliveIntervalSec"), null)
  }
  await input('connectionTimeoutSec', '7'); await input('keepaliveIntervalSec', '0')
  await evaluate("document.querySelector('[role=dialog] button[aria-expanded]').click();document.querySelector('[role=dialog] button[aria-expanded]').click()")
  assert.equal(await evaluate("document.querySelector('[name=connectionTimeoutSec]').value"), '7')
  assert.equal(await evaluate("document.querySelector('[name=keepaliveIntervalSec]').value"), '0')
  await save(); await waitFor('!document.querySelector("[role=dialog]")')
  await waitFor("testState.getState().hosts.find(h=>h.id===fileHost.id).connectionTimeoutSec===7")
  assert.equal(await evaluate("testState.getState().hosts.find(h=>h.id===fileHost.id).keepaliveIntervalSec"), 0)
  assert.deepEqual(await evaluate('testState.getState().tabs.map(t=>t.id)'), await evaluate('m4bTabs'))
  for (const [theme, locale] of [['light','zh'], ['dark','zh'], ['dark','en']]) {
    await evaluate(`await hopline.settings.update({theme:${JSON.stringify(theme)},language:${JSON.stringify(locale)}});await testState.reloadCatalog()`)
    await open()
    assert.equal(await evaluate("document.querySelector('[role=dialog] button[aria-expanded]').getAttribute('aria-expanded')"), 'true')
    assert.equal(await evaluate("document.querySelector('[name=connectionTimeoutSec]').value"), '7')
    assert.equal(await evaluate("document.querySelector('[name=keepaliveIntervalSec]').value"), '0')
    await evaluate("document.querySelector('[name=connectionTimeoutSec]').scrollIntoView({block:'center'})")
    await capture(context, `connection-${theme}-${locale}`)
    if (locale === 'en') {
      await input('connectionTimeoutSec', '2'); await save()
      await waitFor("document.querySelector('[role=dialog] [role=alert]')?.textContent==='Connection timeout must be an integer from 5 to 120 seconds'")
    }
    await key('Escape')
  }
  await evaluate("await hopline.settings.update({language:'zh',theme:'light'});await testState.reloadCatalog()")
  await open(); await input('connectionTimeoutSec', ''); await input('keepaliveIntervalSec', ''); await save()
  await waitFor('!document.querySelector("[role=dialog]")')
  await waitFor("testState.getState().hosts.find(h=>h.id===fileHost.id).connectionTimeoutSec===null")
  await open()
  assert.equal(await evaluate("document.querySelector('[name=connectionTimeoutSec]').value"), '')
  assert.equal(await evaluate("document.querySelector('[name=keepaliveIntervalSec]').value"), '')
  await key('Escape')
  console.log('PASS M4-B connection range errors, saved/reopened values, zero heartbeat, collapsed drafts, blank defaults and live tab preservation')
}

export async function securityPageSmoke(context, report) {
  const { evaluate, waitFor, main } = context
  for (const [theme, locale] of [['light','zh'], ['dark','zh'], ['dark','en']]) {
    await evaluate(`testState.patch({securityHost:null,toasts:[]});await hopline.settings.update({theme:${JSON.stringify(theme)},language:${JSON.stringify(locale)}});await testState.reloadCatalog();testNav.openHost(fileHost.id,'security')`)
    await waitFor('document.querySelector("section[aria-label] article")')
    assert.equal(await evaluate("Array.from(document.querySelectorAll('summary')).some(el=>/原始数据|Raw data|security\\.raw/.test(el.textContent))"), false)
    assert.equal(await evaluate("document.body.innerText.includes('展开原始数据')"), false)
    const copyLabel = locale === 'zh' ? '复制命令' : 'Copy commands'
    await main.evaluate('globalThis.polishCopied=null;undefined')
    await evaluate(`Array.from(document.querySelectorAll('section[aria-label] article button')).find(b=>b.textContent===${JSON.stringify(copyLabel)}).click()`)
    const expected = await evaluate(`(await import('/src/logic/security.ts')).commandsText(${JSON.stringify(report.results.find(r=>r.status==='fail'&&r.fix?.commands).fix.commands)},${JSON.stringify(locale)})`)
    await waitFor(`testState.getState().toasts.some(t=>t.text===${JSON.stringify(locale==='zh'?'命令已复制':'Commands copied')})`)
    assert.equal(await main.evaluate('globalThis.polishCopied'), expected)
    assert.ok(!expected.split('\n').some(line=>line.startsWith('$ ')))
    assert.equal(await evaluate("Array.from(document.querySelectorAll('section[aria-label] article button')).some(b=>/^(执行|运行命令|Run|Execute)$/.test(b.textContent))"), false)
    // The report and original evidence remain available to their existing consumers.
    assert.deepEqual(await evaluate('await hopline.security.latest(fileHost.id)'), report)
    await evaluate("testState.patch({toasts:[]});document.querySelector('section[aria-label]').scrollTop=0")
    await capture(context, `security-${theme}-${locale}`)
    await evaluate("document.querySelector('section[aria-label] article').scrollIntoView({block:'start'})")
    await capture(context, `security-finding-${theme}-${locale}`)
  }
  // Use a separate report per assertion, going through the real panel's latest-report IPC.
  const rules = report.results.filter(row => row.id !== 'ssh-default-port').slice(0, 3)
  const rulesModule = '/@fs' + path.resolve(import.meta.dirname, '../../src/core/security/rules.ts')
  for (const [locale, cases] of [
    ['zh', [
      [['pass'], '全部通过'], [['pass', 'ignored'], '通过 · 已忽略 1 项'],
      [['pass', 'unknown'], '已检项通过'], [['pass', 'unknown', 'ignored'], '已检项通过 · 已忽略 1 项'],
      [['unknown'], '无法确认'], [['ignored'], '无通过结果 · 已忽略 1 项'],
      [['fail', 'unknown', 'ignored'], '发现 1 个问题']
    ]],
    ['en', [
      [['pass'], 'All passed'], [['pass', 'ignored'], 'Passed · 1 ignored'],
      [['pass', 'unknown'], 'Checked items passed'], [['pass', 'unknown', 'ignored'], 'Checked items passed · 1 ignored'],
      [['unknown'], 'Could not verify'], [['ignored'], 'No passing results · 1 ignored'],
      [['fail', 'unknown', 'ignored'], '1 issue found']
    ]]
  ]) {
    await evaluate(`await hopline.settings.update({language:'${locale}'});await testState.reloadCatalog()`)
    for (const [statuses, title] of cases) {
      const results = statuses.map((status, index) => ({...rules[index], status}))
      const score = await evaluate(`(await import(${JSON.stringify(rulesModule)})).securityScore(${JSON.stringify(results)})`)
      await main.evaluate(`testElectron.ipcMain.removeHandler('security:latest');testElectron.ipcMain.handle('security:latest',()=>(${JSON.stringify({...report, results, score})}));undefined`)
      await evaluate("testNav.openHost(fileHost.id,'status')")
      await waitFor("testState.getState().route.section==='status'")
      await evaluate("testNav.openHost(fileHost.id,'security')")
      await waitFor(`!!Array.from(document.querySelectorAll('h2')).find(el=>el.textContent===${JSON.stringify(title)} && el.getClientRects().length)`)
      if (statuses.length === 3 && statuses[0] === 'pass') await capture(context, `security-coverage-${locale}`)
    }
  }
  await main.evaluate(`testElectron.ipcMain.removeHandler('security:latest');testElectron.ipcMain.handle('security:latest',()=>(${JSON.stringify(report)}));undefined`)
  console.log('PASS bilingual security headings for passed, ignored, unknown, mixed coverage and failure')
  console.log('PASS M4-B security page has no raw-data disclosure in both languages, preserves reports, and copies exact commands without executing')
}
