// Render the existing Mark geometry as a monochrome macOS template; no new logo.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { iconSvg } = require('./linux-icon-source.cjs')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  const { app, BrowserWindow } = require('electron')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-tray-icon-'))
  app.setPath('userData', profile); app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.whenReady().then(async () => {
    let win
    try {
      const svg = iconSvg(root).replace(/^<\?xml[^]*?\?>\s*/, '').replace(/<rect[^>]*\/>/, '').replace(/#[a-f\d]{6}/gi, '#000000')
      const dir = path.join(root, 'src/main/assets'); fs.mkdirSync(dir, { recursive: true })
      win = new BrowserWindow({ width: 512, height: 512, useContentSize: true, show: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true, sandbox: true } })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;background:transparent}</style>${svg}`))
      const image = (await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })).resize({ width: 36, height: 36, quality: 'best' })
      if (image.isEmpty()) throw Error('图标为空')
      fs.writeFileSync(path.join(dir, 'trayTemplate.png'), image.toPNG())
      console.log('PASS tray template derived from existing Mark')
    } finally { win?.destroy(); fs.rmSync(profile, { recursive: true, force: true }) }
  }).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
}
