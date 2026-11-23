#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { iconSvg, sizes } = require('./linux-icon-source.cjs')

const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  const { app, BrowserWindow } = require('electron')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-linux-icons-'))
  app.setPath('userData', profile)
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.whenReady().then(async () => {
    let window
    try {
      const svg = iconSvg(root)
      // Keep Linux assets below a platform-specific directory. Generic build/icon
      // names are also auto-discovered by electron-builder for macOS.
      const directory = path.join(root, 'build/linux/icons')
      fs.mkdirSync(directory, { recursive: true })
      window = new BrowserWindow({ width: 512, height: 512, useContentSize: true, show: false,
        transparent: true, backgroundColor: '#00000000',
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:512px;height:512px;overflow:hidden;background:transparent}svg{display:block}</style>${svg.replace(/^<\?xml[^]*?\?>\s*/, '')}`
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      const rendered = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
      if (rendered.isEmpty()) throw new Error('图标渲染为空')
      fs.writeFileSync(path.join(root, 'build/linux/icon.svg'), svg)
      for (const size of sizes) {
        const image = rendered.resize({ width: size, height: size, quality: 'best' })
        fs.writeFileSync(path.join(directory, `${size}.png`), image.toPNG())
      }
      console.log(`已从现有 Mark 生成 Linux 图标：${sizes.join(', ')} 像素；浅色主题颜色，原几何不变。`)
    } finally {
      window?.destroy()
      fs.rmSync(profile, { recursive: true, force: true })
    }
  }).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
}
