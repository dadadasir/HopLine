import { PassThrough } from 'node:stream'
import { Client, utils, type ClientChannel, type ConnectConfig } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectEndpoint, type Endpoint, type HostCheck } from '../src/main/ssh/connect'
import * as net from '../src/main/ssh/net'

const endpoints: Endpoint[] = [1, 2, 3].map((index) => ({
  host: `host${index}.test`, port: 2200 + index, username: `user${index}`,
  auth: { authType: 'password', password: `secret${index}`, privateKey: null, privateKeyPath: null, passphrase: null }
}))
const key = utils.parseKey(utils.generateKeyPairSync('ed25519').private)
if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid test key')
const hostKey = key.getPublicSSH()
const options = { verifyHost: vi.fn(async (_check: HostCheck) => true), onKeyboard: async () => null }
let clients: Client[]
let configs: ConnectConfig[]
let streams: PassThrough[]
let ended: Client[]
let failAt: number
let failForward: boolean
let closeEarly: boolean

beforeEach(() => {
  clients = []; configs = []; streams = []; ended = []
  failAt = -1; failForward = false; closeEarly = false
  options.verifyHost.mockClear()
  vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, config) {
    clients.push(this)
    configs.push(config)
    const index = clients.length - 1
    const verify = config.hostVerifier as (key: Buffer, callback: (accepted: boolean) => void) => void
    verify(hostKey, () => {
      if (index === failAt) this.emit(closeEarly ? 'close' : 'error', new Error('All configured authentication methods failed'))
      else this.emit('ready')
    })
    return this
  })
  vi.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) { ended.push(this); return this })
  vi.spyOn(Client.prototype, 'forwardOut').mockImplementation(function (this: Client, _source, _port, host, port, callback) {
    const next = endpoints[clients.indexOf(this) + 1]!
    expect({ host, port }).toEqual({ host: next.host, port: next.port })
    if (failForward) { callback!(new Error('forward refused'), undefined as never); return this }
    const stream = new PassThrough()
    streams.push(stream)
    callback!(undefined, stream as unknown as ClientChannel)
    return this
  })
})
afterEach(() => { streams.forEach((stream) => stream.destroy()); vi.restoreAllMocks() })

describe('jump chain without sockets', () => {
  it.each([
    { settings: {}, readyTimeout: 20_000, keepaliveInterval: 10_000 },
    { settings: { connectionTimeoutSec: null, keepaliveIntervalSec: null }, readyTimeout: 20_000, keepaliveInterval: 10_000 },
    { settings: { connectionTimeoutSec: 7, keepaliveIntervalSec: 23 }, readyTimeout: 7000, keepaliveInterval: 23_000 },
    { settings: { connectionTimeoutSec: 5, keepaliveIntervalSec: 0 }, readyTimeout: 5000, keepaliveInterval: 0 },
    { settings: { connectionTimeoutSec: 120, keepaliveIntervalSec: 300 }, readyTimeout: 120_000, keepaliveInterval: 300_000 }
  ])('applies destination connection settings to every jump: $settings', async ({ settings, readyTimeout, keepaliveInterval }) => {
    const jumps = endpoints.slice(0, 2).map((endpoint) => ({
      ...endpoint, connectionTimeoutSec: 6, keepaliveIntervalSec: 6
    }))
    await connectEndpoint({ ...endpoints[2]!, ...settings }, { ...options, jumps })
    expect(configs).toHaveLength(3)
    for (const config of configs) {
      expect(config).toMatchObject({ readyTimeout, keepaliveInterval, keepaliveCountMax: 3 })
    }
  })

  it.each([false, true])('routes only the first hop through proxy=%s, verifies every endpoint, and forwards in order', async (proxy) => {
    const proxySocket = new PassThrough()
    streams.push(proxySocket)
    const openProxy = vi.spyOn(net, 'openProxySocket').mockResolvedValue(proxySocket as never)
    const endpoint: net.ProxyEndpoint = { type: 'socks5', host: 'proxy.test', port: 1080, username: null, password: null }
    const opened = await connectEndpoint(endpoints[2]!, { ...options, jumps: endpoints.slice(0, 2), proxy: proxy ? endpoint : null })
    expect(opened).toEqual({ client: clients[2], jumps: clients.slice(0, 2) })
    expect(configs.map((config) => [config.host, config.port, config.username, config.password])).toEqual(endpoints.map((item) => [item.host, item.port, item.username, item.auth.password]))
    expect(options.verifyHost.mock.calls.map(([check]) => [check.host, check.port])).toEqual(endpoints.map((item) => [item.host, item.port]))
    expect(configs.map((config) => config.sock)).toEqual([proxy ? proxySocket : undefined, streams[1], streams[2]])
    if (proxy) expect(openProxy).toHaveBeenCalledExactlyOnceWith(endpoint, 'host1.test', 2201)
    else expect(openProxy).not.toHaveBeenCalled()
    expect(ended).toEqual([])
  })

  it.each([0, 1, 2])('cleans up in reverse order when endpoint %s fails, leaving target errors unchanged', async (index) => {
    failAt = index
    const prefix = index < 2 ? `跳板 ${index + 1}（${endpoints[index]!.host}:${endpoints[index]!.port}）：` : ''
    await expect(connectEndpoint(endpoints[2]!, { ...options, jumps: endpoints.slice(0, 2) })).rejects.toThrow(
      `${prefix}认证失败，请检查用户名、密码或私钥`
    )
    expect(ended).toEqual([...clients].reverse())
    expect(clients).toHaveLength(index + 1)
    if (index > 0) expect(streams.at(-1)!.destroyed).toBe(true)
  })

  it('attributes forwarding failures to the next jump and closes the previous one', async () => {
    failForward = true
    await expect(connectEndpoint(endpoints[2]!, { ...options, jumps: endpoints.slice(0, 2) })).rejects.toThrow('跳板 2（host2.test:2202）：forward refused')
    expect(ended).toEqual([clients[0]])
  })

  it('rejects an early handshake close and releases the preceding jump', async () => {
    failAt = 1; closeEarly = true
    await expect(connectEndpoint(endpoints[2]!, { ...options, jumps: endpoints.slice(0, 2) })).rejects.toThrow('跳板 2（host2.test:2202）：连接已断开')
    expect(ended).toEqual([...clients].reverse())
  })

  it('keeps direct connections free of forwarding and returns an empty jump list', async () => {
    const opened = await connectEndpoint(endpoints[0]!, options)
    expect(opened).toEqual({ client: clients[0], jumps: [] })
    expect(Client.prototype.forwardOut).not.toHaveBeenCalled()
  })
})
