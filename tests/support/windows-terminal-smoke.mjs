import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function windowsTerminalSmoke({ browser, main, evaluate, waitFor, click, screenshotDirectory }) {
  assert.equal(await evaluate('hopline.platform'), 'win32')
  assert.equal(await evaluate('testUi.shortcutLabel()'), 'Ctrl+Shift+')
  await evaluate(`testState.patch({toasts:[]}); window.windowsProbeId = (await testState.openLocal()).id`)
  await waitFor("testState.getState().activeId === windowsProbeId && document.activeElement?.closest('.terminal-surface')")
  await evaluate(`window.windowsProbe = testRegistry.terminalOf(windowsProbeId)
    window.windowsInput = []
    windowsProbe.onData(text => windowsInput.push(text))`)
  const chord = async (key, code, virtualKey, modifiers) => {
    const params = { key, code, windowsVirtualKeyCode: virtualKey, modifiers }
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  await chord('w', 'KeyW', 87, 2)
  assert.deepEqual(await evaluate('windowsInput'), ['\x17'])
  assert.equal(await evaluate('testState.getState().tabs.some(tab => tab.id === windowsProbeId)'), true)

  const openContext = () => evaluate(`document.activeElement.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2
  }))`)
  await main.evaluate(`globalThis.smokeClipboard = {
      readText: testElectron.clipboard.readText, writeText: testElectron.clipboard.writeText
    };
    testElectron.clipboard.readText = () => '\\r\\n\\r\\n';
    testElectron.clipboard.writeText = () => {}; undefined`)
  const dialog = '[role=dialog][aria-label="粘贴多行文本"]'
  const waitForDialog = () => waitFor(`document.querySelector(${JSON.stringify(dialog)})`)
  const waitForTerminalFocus = () => waitFor("!testState.getState().confirm && document.activeElement?.closest('.terminal-surface')")
  const cancelPaste = async () => {
    await click(`${dialog} button.text-muted:not([aria-label])`)
    await waitForTerminalFocus()
  }
  let pastedInput
  try {
    assert.equal(await openContext(), false)
    await waitForDialog()
    assert.deepEqual(await evaluate('windowsInput'), ['\x17'])
    await evaluate(`Promise.all(document.querySelector(${JSON.stringify(dialog)}).getAnimations().map(animation => animation.finished))`)
    const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = join(screenshotDirectory, 'hopline-windows-terminal-paste.png')
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    await cancelPaste()
    assert.deepEqual(await evaluate('windowsInput'), ['\x17'])

    await openContext()
    await waitForDialog()
    await click(`${dialog} button.bg-accent`)
    await waitForTerminalFocus()
    pastedInput = await evaluate('windowsInput')
    assert.equal(pastedInput.length, 2)
    assert.equal(pastedInput[1].replace(/^\x1b\[200~|\x1b\[201~$/g, ''), '\r\r')
    console.log(`PASS Windows renderer prompts before right-click multiline paste, with cancel and confirm; screenshot: ${screenshotPath}`)

    await chord('V', 'KeyV', 86, 2 | 8)
    await waitForDialog()
    await cancelPaste()
    assert.deepEqual(await evaluate('windowsInput'), pastedInput)
    assert.equal(await evaluate(`(() => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', '\\n')
      return document.activeElement.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    })()`), false)
    await waitForDialog()
    await cancelPaste()
    assert.deepEqual(await evaluate('windowsInput'), pastedInput)
  } finally {
    await main.evaluate('Object.assign(testElectron.clipboard, smokeClipboard); delete globalThis.smokeClipboard')
  }

  await chord('W', 'KeyW', 87, 2 | 8)
  await waitFor('!testState.getState().tabs.some(tab => tab.id === windowsProbeId)')
  assert.deepEqual(await evaluate('windowsInput'), pastedInput)
  console.log('PASS terminal focus sends Ctrl+W to xterm and closes the tab only on Ctrl+Shift+W')

  await chord(')', 'Digit0', 48, 2 | 8)
  assert.equal(await evaluate('testState.getState().route.page'), 'overview')
  await chord('!', 'Digit1', 49, 2 | 8)
  assert.equal(await evaluate("testState.getState().route.page === 'sessions' && testState.getState().activeId === testState.getState().tabs[0].id"), true)
  await chord('<', 'Comma', 188, 2 | 8)
  assert.equal(await evaluate('testState.getState().settingsOpen'), 'appearance')
  await evaluate('testState.patch({settingsOpen:false})')
}
