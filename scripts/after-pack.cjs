const fs = require('node:fs')
const path = require('node:path')

// Arch enum in builder-util: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }

// A custom electronDist may still contain Electron's demo app. Remove only the
// copied demo inside this output bundle, never anything in the source distribution.
// When cross-packaging Windows from macOS/Linux, also prune host-OS build artifacts
// and non-target arch prebuilds from app.asar.unpacked so node-pty loads win32 N-API prebuilds cleanly.
module.exports = function afterPack({ appOutDir, electronPlatformName, arch, packager }) {
  const resources = packager.getResourcesDir(appOutDir)
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true })

  if (electronPlatformName === 'darwin') {
    const prebuilds = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
    if (fs.existsSync(prebuilds)) {
      for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('darwin-')) continue
        const helper = path.join(prebuilds, entry.name, 'spawn-helper')
        if (!fs.existsSync(helper)) continue
        if (!fs.lstatSync(helper).isFile()) throw new Error('打包的 spawn-helper 必须是普通文件')
        // afterPack runs before signing; keep fallback helpers executable too.
        fs.chmodSync(helper, 0o755)
      }
    }
  }

  if (electronPlatformName === 'win32') {
    const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules')
    if (process.platform !== 'win32') {
      fs.rmSync(path.join(unpackedModules, 'node-pty', 'build'), { recursive: true, force: true })
      fs.rmSync(path.join(unpackedModules, 'cpu-features', 'build'), { recursive: true, force: true })
    }
    const targetArch = ARCH_NAMES[arch]
    const prebuildsDir = path.join(unpackedModules, 'node-pty', 'prebuilds')
    if (targetArch && fs.existsSync(prebuildsDir)) {
      const keep = `win32-${targetArch}`
      for (const entry of fs.readdirSync(prebuildsDir)) {
        if (entry !== keep) {
          fs.rmSync(path.join(prebuildsDir, entry), { recursive: true, force: true })
        }
      }
    }
  }
}
