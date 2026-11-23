// macOS application/Dock icon derived from the same existing Mark as Linux.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { iconSvg } = require('./linux-icon-source.cjs')
const root = path.resolve(__dirname, '..')
if (process.platform !== 'darwin') throw new Error('生成 ICNS 需要 macOS 的 iconutil。')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  const { app, BrowserWindow } = require('electron')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-app-icon-'))
  app.setPath('userData', path.join(profile, 'profile')); app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.whenReady().then(async () => {
    let window
    try {
      const svg = iconSvg(root).replace('width="512" height="512"', 'width="1024" height="1024"')
      const output = path.join(root, 'build/mac'), iconset = path.join(profile, 'HopLine.iconset')
      fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(iconset)
      window = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false,
        transparent: true, backgroundColor: '#00000000',
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:1024px;height:1024px;background:transparent}svg{display:block}</style>${svg.replace(/^<\?xml[^]*?\?>\s*/, '')}`))
      const rendered = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
      if (rendered.isEmpty()) throw new Error('APP 图标渲染为空')
      for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
        const pixels = size * scale
        fs.writeFileSync(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
          rendered.resize({ width: pixels, height: pixels, quality: 'best' }).toPNG())
      }
      const result = spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(output, 'icon.icns')], { encoding: 'utf8' })
      if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || 'ICNS 生成失败')
      fs.writeFileSync(path.join(output, 'icon.png'), rendered.toPNG())
      fs.writeFileSync(path.join(output, 'icon.svg'), svg)
      console.log('已从现有 HopLine Mark 生成 macOS APP/Dock 图标，保留原几何与配色。')
    } finally { window?.destroy(); fs.rmSync(profile, { recursive: true, force: true }) }
  }).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
}
