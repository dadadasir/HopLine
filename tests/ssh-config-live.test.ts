import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { utils, type PublicKeyAuthContext } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
import { parseSshConfig } from '../src/core/ssh-config'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { generateAgentKey, startMiniAgent } from './support/mini-agent.mjs'
import { startMiniSshd } from './support/mini-sshd.mjs'

let directory: string
let agent: Awaited<ReturnType<typeof startMiniAgent>> | undefined
const servers: Awaited<ReturnType<typeof startMiniSshd>>[] = []
let pool: ConnectionPool | undefined
afterEach(async () => {
  await pool?.closeAll()
  for (const server of servers.splice(0).reverse()) await server.close()
  await agent?.close()
  vi.unstubAllEnvs()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

it('imports direct and two-jump connections using a custom agent socket and only the specified identity on every hop', async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-import-live-'))
  const keys = Array.from({ length: 3 }, () => generateAgentKey())
  const publicFile = path.join(directory, 'selected.pub')
  fs.writeFileSync(publicFile, keys[1].public)
  agent = await startMiniAgent(keys.map((key) => key.private))
  vi.stubEnv('SSH_AUTH_SOCK', path.join(directory, 'wrong.sock'))
  const attempts: PublicKeyAuthContext[][] = [[], [], []]
  for (let index = 0; index < 3; index++) {
    servers.push(await startMiniSshd({ root: path.join(directory, String(index)), publicKey: publicFile,
      username: `hop${index}`, onAuthentication: (ctx) => { if (ctx.method === 'publickey') attempts[index].push(ctx) }
    }))
  }
  const config = servers.map((server, index) => `Host ${index === 2 ? 'target' : `jump${index}`}\n HostName 127.0.0.1\n Port ${server.port}\n User ${server.username}\n${index === 2 ? ' ProxyJump jump0,jump1\n' : ''}`).join('') +
    `Host direct\n HostName 127.0.0.1\n Port ${servers[2].port}\n User ${servers[2].username}\nHost *\n IdentityAgent "${agent.socket}"\n IdentityFile "${publicFile}"\n IdentitiesOnly yes`
  const configFile = path.join(directory, 'config')
  fs.writeFileSync(configFile, config)
  const preview = parseSshConfig(configFile, (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, directory)
  expect(preview.warnings).toEqual([])
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const target = vault.saveHost(preview.hosts.find((host) => host.name === 'target')!)
  const direct = vault.saveHost(preview.hosts.find((host) => host.name === 'direct')!)
  // Exercise the portable boundary before the connection pool consumes the imported data.
  const restored = new Vault(emptyStore(), new MemorySecretCodec())
  restored.importPortable(vault.exportPortable(), 'replace')
  pool = new ConnectionPool(restored, { verifyHost: async () => true, onKeyboard: async () => null })
  expect(await pool.exec(direct.id, 'printf direct-ok')).toMatchObject({ code: 0, stdout: 'direct-ok' })
  expect(await pool.exec(target.id, 'printf chain-ok')).toMatchObject({ code: 0, stdout: 'chain-ok' })
  expect(servers.map((server) => server.acceptedConnections)).toEqual([1, 1, 2])
  const key = utils.parseKey(keys[1].public)
  if (key instanceof Error) throw key
  for (const [index, offered] of attempts.entries()) {
    expect(offered.filter((ctx) => !ctx.signature)).toHaveLength(index === 2 ? 2 : 1)
    expect(offered.every((ctx) => ctx.key.data.equals(key.getPublicSSH()))).toBe(true)
    for (const ctx of offered.filter((ctx) => ctx.signature)) expect(key.verify(ctx.blob!, ctx.signature!, ctx.hashAlgo)).toBe(true)
  }
  expect(agent.identityRequests).toBe(4)
  expect(agent.signedKeys).toEqual(Array(4).fill(key.getPublicSSH()))
})
