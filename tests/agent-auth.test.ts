import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, OpenSSHAgent, utils, type ConnectConfig, type ParsedKey } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectEndpoint, PageantStream, type Endpoint } from '../src/main/ssh/connect'
import { generateAgentKey } from './support/mini-agent.mjs'

let directory: string
const options = { verifyHost: async () => true, onKeyboard: async () => null }
const endpoint = (): Endpoint => ({ host: 'example.test', port: 22, username: 'hop', auth: {
  authType: 'agent', password: 'ignored', privateKey: 'ignored', privateKeyPath: null, passphrase: 'ignored'
} })

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-agent-unit-')) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

function captureConfig() {
  let config!: ConnectConfig
  vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, value) {
    config = value
    queueMicrotask(() => this.emit('ready'))
    return this
  })
  return () => config
}

function identity(agent: ConnectConfig['agent']): Promise<unknown[]> {
  if (!(agent instanceof OpenSSHAgent)) throw new Error('Expected OpenSSHAgent')
  return new Promise((resolve, reject) => agent.getIdentities((error, keys) => error ? reject(error) : resolve(keys ?? [])))
}

function publicKey(): { key: ParsedKey; text: string } {
  const pair = generateAgentKey()
  const key = utils.parseKey(pair.public)
  if (key instanceof Error) throw key
  return { key, text: pair.public }
}

describe('agent configuration without listeners', () => {
  it('reports an empty SSH_AUTH_SOCK before attempting a network connection', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    const connect = vi.spyOn(Client.prototype, 'connect')
    await expect(connectEndpoint(endpoint(), options)).rejects.toThrow('未找到 ssh-agent（SSH_AUTH_SOCK 为空），请在主机设置里指定 agent socket')
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports the expanded missing socket path before connecting', async () => {
    const target = endpoint()
    target.auth.agent = { socket: '~/hopline-missing-agent.sock', identityFile: null, forward: false }
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    await expect(connectEndpoint(target, options)).rejects.toThrow(`agent socket 不存在：${path.join(os.homedir(), 'hopline-missing-agent.sock')}`)
    expect(exists).toHaveBeenCalledWith(path.join(os.homedir(), 'hopline-missing-agent.sock'))
  })

  it.each([false, true])('uses the default agent with forwarding=%s and no password/private key', async (forward) => {
    const socket = path.join(directory, 'agent.sock')
    fs.writeFileSync(socket, '')
    vi.stubEnv('SSH_AUTH_SOCK', socket)
    const config = captureConfig()
    const target = endpoint()
    target.auth.agent = { socket: null, identityFile: null, forward }
    const opened = await connectEndpoint(target, options)
    expect(config()).toMatchObject({ agent: socket, agentForward: forward })
    for (const field of ['privateKey', 'password', 'passphrase']) expect(config()).not.toHaveProperty(field)
    opened.client.end()
  })

  it.each(['privateKey', 'password', 'keyboard-interactive'] as const)('never attaches an environment agent for %s', async (authType) => {
    vi.stubEnv('SSH_AUTH_SOCK', '/should-not-be-used')
    const config = captureConfig()
    const target = endpoint()
    target.auth.authType = authType
    target.auth.agent = { socket: '/also-ignored', identityFile: null, forward: true }
    const opened = await connectEndpoint(target, options)
    expect(config()).not.toHaveProperty('agent')
    expect(config()).not.toHaveProperty('agentForward')
    if (authType === 'privateKey') expect(config().privateKey).toBe('ignored')
    opened.client.end()
  })

  it('filters three identities by public blob, regardless of comments, and reports a missing key', async () => {
    const keys = [publicKey(), publicKey(), publicKey()]
    const file = path.join(directory, 'identity.pub')
    fs.writeFileSync(file, `${keys[1]!.text} different comment`)
    const config = captureConfig()
    const target = endpoint()
    target.auth.agent = { socket: directory, identityFile: file, forward: false }
    const opened = await connectEndpoint(target, options)
    const getIdentities = vi.spyOn(OpenSSHAgent.prototype, 'getIdentities').mockImplementation((cb) => cb(null, keys.map(({ key }) => key)))
    expect(await identity(config().agent)).toEqual([keys[1]!.key])
    getIdentities.mockImplementation((cb) => cb(null, [keys[0]!.key, keys[2]!.key]))
    await expect(identity(config().agent)).rejects.toThrow(`agent 中没有与 ${file} 匹配的钥匙`)
    getIdentities.mockImplementation((cb) => cb(new Error('agent unavailable')))
    await expect(identity(config().agent)).rejects.toThrow('agent unavailable')
    opened.client.end()
  })

  it('retains the original agent error when ssh2 subsequently reports exhausted authentication', async () => {
    const target = endpoint()
    target.auth.agent = { socket: directory, identityFile: null, forward: false }
    let client!: Client
    vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
      client = this
      return this
    })
    const pending = connectEndpoint(target, options)
    const rejected = expect(pending).rejects.toThrow('agent 中没有与 key.pub 匹配的钥匙')
    expect(() => {
      client.emit('error', new Error('agent 中没有与 key.pub 匹配的钥匙'))
      client.emit('error', new Error('All configured authentication methods failed'))
    }).not.toThrow()
    await rejected
  })

  it('rejects a private key used as identityFile', async () => {
    const file = path.join(directory, 'not-public.pub')
    fs.writeFileSync(file, generateAgentKey().private)
    const target = endpoint()
    target.auth.agent = { socket: directory, identityFile: file, forward: false }
    await expect(connectEndpoint(target, options)).rejects.toThrow(`无法解析公钥文件：${file}`)
  })

  it('frames Pageant helper requests over unpacked binary path and surfaces exit code 11 when Pageant is not running', async () => {
    const mockExe = path.join(directory, 'mock-pagent')
    fs.writeFileSync(
      mockExe,
      `#!${process.execPath}\nconst chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{const buf=Buffer.concat(chunks);if(Number(process.argv[2])!==buf.length)process.exit(15);if(buf[4]===99)process.exit(11);const reply=Buffer.from([0,0,0,1,12]);process.stdout.write(reply)});\n`,
      { mode: 0o700 }
    )

    const okStream = new PageantStream(mockExe)
    const okChunks: Buffer[] = []
    okStream.on('data', (chunk: Buffer) => okChunks.push(chunk))
    await new Promise<void>((resolve, reject) => {
      // Split across two writes to verify length-prefixed reassembly.
      okStream.write(Buffer.from([0, 0]), (err) => (err ? reject(err) : undefined))
      okStream.write(Buffer.from([0, 1, 11]), (err) => (err ? reject(err) : resolve()))
    })
    expect(Buffer.concat(okChunks)).toEqual(Buffer.from([0, 0, 0, 1, 12]))
    okStream.destroy()

    const downStream = new PageantStream(mockExe)
    await expect(
      new Promise<void>((resolve, reject) => {
        downStream.on('error', reject)
        downStream.write(Buffer.from([0, 0, 0, 1, 99]), (err) => (err ? reject(err) : resolve()))
      })
    ).rejects.toThrow('Pageant is not running')
  })
})
