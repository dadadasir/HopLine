// Minimal same-runtime control. No HopLine services, React, network or user data.
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
if (process.env.HOPLINE_PERF !== '1' || !process.env.HOPLINE_USER_DATA) throw new Error('基线只能由隔离性能测量运行')
app.setPath('userData', process.env.HOPLINE_USER_DATA)
app.setName('HopLine 性能基线')
const startedAt = performance.now()
app.whenReady().then(async () => {
  const mac = process.platform === 'darwin'
  const win = new BrowserWindow({ width: 1160, height: 740, minWidth: 860, minHeight: 560, show: false,
    title: 'HopLine 性能基线', backgroundColor: '#f3f1ec', frame: mac,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden', trafficLightPosition: { x: 18, y: 18 }, autoHideMenuBar: !mac,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: false, allowRunningInsecureContent: false } })
  win.webContents.setBackgroundThrottling(false)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  let timer
  const firstPaint = event => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    ipcMain.removeListener('perf:first-paint', firstPaint)
    const coldStartMs = process.uptime() * 1000, firstPaintMs = performance.now() - startedAt
    console.log('HOPLINE_PERF_FIRST_PAINT')
    timer = setTimeout(() => {
      const idleMemoryMB = app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024
      console.log(`HOPLINE_PERF ${JSON.stringify({ coldStartMs, firstPaintMs, idleMemoryMB })}`)
      app.quit()
    }, 10_000)
  }
  ipcMain.on('perf:first-paint', firstPaint)
  win.once('closed', () => { clearTimeout(timer); ipcMain.removeListener('perf:first-paint', firstPaint); app.quit() })
  win.once('ready-to-show', () => win.show())
  await win.loadFile(path.join(__dirname, 'index.html'))
}).catch(error => { console.error(error); app.exit(1) })
