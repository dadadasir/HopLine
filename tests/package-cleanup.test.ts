import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
const afterPack = createRequire(import.meta.url)('../scripts/after-pack.cjs')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-afterpack-'))
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
it('从打包副本清除 Electron 示例，保留产品文件与自定义来源且可重复执行', () => {
  const output = path.join(directory, 'out'), source = path.join(directory, 'electronDist')
  const resources = path.join(output, 'Hopline.app/Contents/Resources')
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(source)
  fs.writeFileSync(path.join(resources, 'default_app.asar'), 'demo')
  fs.writeFileSync(path.join(resources, 'app.asar'), 'product')
  fs.writeFileSync(path.join(source, 'default_app.asar'), 'source demo')
  const context = { appOutDir: output, packager: { getResourcesDir: () => resources } }
  afterPack(context); afterPack(context)
  expect(fs.existsSync(path.join(resources, 'default_app.asar'))).toBe(false)
  expect(fs.readFileSync(path.join(resources, 'app.asar'), 'utf8')).toBe('product')
  expect(fs.readFileSync(path.join(source, 'default_app.asar'), 'utf8')).toBe('source demo')
})

it('在签名前为 Mac 目标所有 darwin 预构建 spawn-helper 补齐 0755，不修改来源', () => {
  const resources = path.join(directory, 'out/Resources')
  const prebuilds = path.join(resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds')
  for (const arch of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const folder = path.join(prebuilds, arch)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'spawn-helper'), 'fixture', { mode: 0o644 })
  }
  const source = path.join(directory, 'source-helper')
  fs.writeFileSync(source, 'source', { mode: 0o644 })
  const context = { electronPlatformName: 'darwin', appOutDir: path.dirname(resources), packager: { getResourcesDir: () => resources } }
  afterPack(context); afterPack(context)
  for (const arch of ['darwin-arm64', 'darwin-x64']) expect(fs.statSync(path.join(prebuilds, arch, 'spawn-helper')).mode & 0o777).toBe(0o755)
  expect(fs.statSync(path.join(prebuilds, 'win32-x64/spawn-helper')).mode & 0o777).toBe(0o644)
  expect(fs.statSync(source).mode & 0o777).toBe(0o644)
})

it('不为 Linux 目标改动 darwin 预构建 helper 的权限', () => {
  const resources = path.join(directory, 'out/Resources')
  const helper = path.join(resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
  fs.mkdirSync(path.dirname(helper), { recursive: true })
  fs.writeFileSync(helper, 'fixture', { mode: 0o644 })
  afterPack({ electronPlatformName: 'linux', appOutDir: path.dirname(resources), packager: { getResourcesDir: () => resources } })
  expect(fs.statSync(helper).mode & 0o777).toBe(0o644)
})
