import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const archive = fileURLToPath(new URL('../release/win-unpacked/resources/app.asar', import.meta.url))

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') {
  assert.ok(statSync(archive).isFile(), '找不到 Windows 应用归档')
  const electron = createRequire(import.meta.url)('electron')
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit', timeout: 30_000, windowsHide: true
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  const requireFromApp = createRequire(join(archive, 'out', 'main', 'index.js'))
  const resolved = requireFromApp.resolve('ssh2')
  assert.equal(resolved, join(archive, 'node_modules', 'ssh2', 'lib', 'index.js'), 'ssh2 必须从 app.asar 逻辑路径解析')
  const { utils } = requireFromApp('ssh2')
  const passphrase = randomBytes(32).toString('hex')
  const ed25519 = utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr' }).private
  const rsa = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs1', cipher: 'aes-256-cbc', passphrase }
  }).privateKey

  assert.match(ed25519, /^-----BEGIN OPENSSH PRIVATE KEY-----/)
  assert.match(rsa, /^-----BEGIN RSA PRIVATE KEY-----\r?\nProc-Type: 4,ENCRYPTED/)
  for (const [type, key] of [['ssh-ed25519', ed25519], ['ssh-rsa', rsa]]) {
    assert.ok(utils.parseKey(key, 'incorrect') instanceof Error, `${type} 应拒绝错误的密码`)
    const parsed = utils.parseKey(key, passphrase)
    if (parsed instanceof Error) throw parsed
    assert.equal(parsed.type, type)
    assert.ok(parsed.isPrivateKey(), `${type} 必须解析为私钥`)
  }
  console.log(`PASS Windows ASAR ssh2：${resolved}，已解析带密码的 OpenSSH Ed25519 和 RSA PEM 私钥`)
}
