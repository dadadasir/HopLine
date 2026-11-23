import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { utils, type PublicKeyAuthContext } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { openShell } from '../src/main/ssh/connect'
import { generateAgentKey, startMiniAgent } from './support/mini-agent.mjs'
import { startMiniSshd } from './support/mini-sshd.mjs'

// Real Unix socket / loopback integration; run unchanged outside restricted sandboxes.
describe('agent authentication with mini-agent and mini-sshd', () => {
  let directory: string
  let agent: Awaited<ReturnType<typeof startMiniAgent>> | undefined
  let server: Awaited<ReturnType<typeof startMiniSshd>> | undefined
  let jump: Awaited<ReturnType<typeof startMiniSshd>> | undefined
  let pool: ConnectionPool | undefined
  let vault: Vault
  let keys: ReturnType<typeof utils.generateKeyPairSync>[]
  let publicFiles: string[]
  let attempts: PublicKeyAuthContext[]
  let forwards: number

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-agent-live-'))
    keys = Array.from({ length: 3 }, () => generateAgentKey())
    publicFiles = keys.map((key, index) => {
      const file = path.join(directory, `key-${index}.pub`)
      fs.writeFileSync(file, key.public)
      return file
    })
    attempts = []
    forwards = 0
    vault = new Vault(emptyStore(), new MemorySecretCodec())
  })

  afterEach(async () => {
    await pool?.closeAll()
    await jump?.close()
    await server?.close()
    await agent?.close()
    pool = undefined
    jump = undefined
    server = undefined
    agent = undefined
    vi.unstubAllEnvs()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  async function prepare(identityFile: string | null = null, forward = false) {
    agent = await startMiniAgent(keys.map((key) => key.private))
    vi.stubEnv('SSH_AUTH_SOCK', agent.socket)
    server = await startMiniSshd({ root: path.join(directory, 'server'), publicKey: publicFiles[1],
      onAuthentication: (ctx) => { if (ctx.method === 'publickey') attempts.push(ctx) },
      onAgentForward: () => { forwards++ }
    })
    pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
    return vault.saveHost({ groupId: null, name: 'agent', host: '127.0.0.1', port: server.port, username: 'hop',
      authType: 'agent', agent: { socket: null, identityFile, forward }
    }).id
  }

  function verifySignature() {
    const signed = attempts.filter((ctx) => ctx.signature)
    expect(signed).toHaveLength(1)
    const key = utils.parseKey(keys[1]!.public)
    if (key instanceof Error) throw key
    expect(key.verify(signed[0]!.blob!, signed[0]!.signature!, signed[0]!.hashAlgo)).toBe(true)
  }

  it('logs in through SSH_AUTH_SOCK using the second of three agent keys', async () => {
    const id = await prepare()
    expect(await pool!.exec(id, 'printf agent-ok')).toMatchObject({ code: 0, stdout: 'agent-ok' })
    expect(agent!.identityRequests).toBe(1)
    expect(agent!.signedKeys).toHaveLength(1)
    verifySignature()
    expect(forwards).toBe(0)
  })

  it('offers only the selected key, then signs the server challenge', async () => {
    const id = await prepare(publicFiles[1])
    const lease = await pool!.acquire(id)
    // SSH publickey auth has an unsigned offer followed by a signed proof for the same key.
    expect(attempts.filter((ctx) => !ctx.signature)).toHaveLength(1)
    expect(attempts).toHaveLength(2)
    const key = utils.parseKey(keys[1]!.public)
    if (key instanceof Error) throw key
    expect(attempts.every((ctx) => ctx.key.data.equals(key.getPublicSSH()))).toBe(true)
    expect(agent!.signedKeys).toEqual([key.getPublicSSH()])
    verifySignature()
    lease.release()
  })

  it('reports an unmatched identity without offering any key to the server', async () => {
    const missing = path.join(directory, 'absent.pub')
    fs.writeFileSync(missing, generateAgentKey().public)
    const id = await prepare(missing)
    await expect(pool!.acquire(id)).rejects.toThrow(`agent 中没有与 ${missing} 匹配的钥匙`)
    expect(attempts).toEqual([])
    expect(agent!.signedKeys).toEqual([])
  })

  it('reports a missing explicit socket', async () => {
    const id = await prepare()
    const missing = path.join(directory, 'absent.sock')
    vault.saveHost({ ...vault.getHost(id)!, agent: { socket: missing, identityFile: null, forward: false } })
    await expect(pool!.acquire(id)).rejects.toThrow(`agent socket 不存在：${missing}`)
    expect(server!.acceptedConnections).toBe(0)
  })

  it('uses only the private key even when the environment agent has a valid server key', async () => {
    const id = await prepare()
    vault.saveHost({ ...vault.getHost(id)!, authType: 'privateKey', privateKey: keys[0]!.private })
    await expect(pool!.acquire(id)).rejects.toThrow('认证失败')
    const key = utils.parseKey(keys[0]!.public)
    if (key instanceof Error) throw key
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.key.data).toEqual(key.getPublicSSH())
    expect(agent!.identityRequests).toBe(0)
    expect(agent!.signedKeys).toEqual([])
  })

  it.each([['shell', false], ['shell', true], ['exec', false], ['exec', true]] as const)(
    'requests agent forwarding for %s only when forward=%s', async (channel, forward) => {
      const id = await prepare(publicFiles[1], forward)
      if (channel === 'shell') {
        const lease = await pool!.acquire(id)
        const shell = await openShell(lease.client, 80, 24)
        shell.close()
        lease.release()
      } else {
        expect(await pool!.exec(id, 'printf forwarded')).toMatchObject({ stdout: 'forwarded' })
      }
      expect(forwards).toBe(forward ? 1 : 0)
      // ssh2 enables forwarding once per connection, including subsequent channels.
      await pool!.exec(id, 'true')
      expect(forwards).toBe(forward ? 1 : 0)
    }
  )

  it('authenticates the jump using the environment agent and the target using its selected identity', async () => {
    const id = await prepare(publicFiles[1])
    jump = await startMiniSshd({ root: path.join(directory, 'jump'), publicKey: [publicFiles[0]!, publicFiles[2]!] })
    vault.saveHost({ ...vault.getHost(id)!, jumps: [{
      host: '127.0.0.1', port: jump.port, username: 'hop', authType: 'agent'
    }] })
    expect(await pool!.exec(id, 'printf through-jump')).toMatchObject({ code: 0, stdout: 'through-jump' })
    expect(jump.acceptedConnections).toBe(1)
    expect(agent!.identityRequests).toBe(2)
  })
})
