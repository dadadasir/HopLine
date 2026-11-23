import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import * as connection from '../src/main/ssh/connect'

vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: () => ({ onData() {}, onExit() {}, kill() {} }) }))
let directory: string
let hub: SessionHub
let vault: Vault
const emit = vi.fn()
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-test-prompts-'))
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  hub = new SessionHub(vault, new KnownHostFile(path.join(directory, 'known.json')), emit, directory)
})
afterEach(async () => {
  await hub.closeAll()
  await hub.pool.closeAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
  emit.mockClear()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('names only newly opened local terminals in the current language', async () => {
  vault.updateSettings({ language: 'zh' })
  const chinese = await hub.openLocal(80, 24)
  vault.updateSettings({ language: 'en' })
  const english = await hub.openLocal(80, 24)
  expect(chinese.title).toBe('本地终端')
  expect(english.title).toBe('Local terminal')
  expect(hub.list().map((item) => item.title)).toEqual(['本地终端', 'Local terminal'])
})

it.each(['hostkey:prompt', 'kbd:prompt'])('expires %s once at 120 seconds', async (channel) => {
  vi.useFakeTimers()
  const host = vault.saveHost({ groupId: null, name: 'test', host: 'test', port: 22, username: 'u', authType: 'password' })
  vi.spyOn(connection, 'connectEndpoint').mockImplementation(async (_target, options) => {
    if (channel === 'hostkey:prompt') await options.verifyHost({ host: 'test', port: 22, fingerprint: 'test', keyType: 'test' })
    else await options.onKeyboard({ name: '', instructions: '', prompts: [] })
    throw new Error('rejected')
  })
  const connected = hub.connect(host.id, 80, 24).catch(() => null)
  await vi.advanceTimersByTimeAsync(0)
  const requestId = emit.mock.calls.find(([name]) => name === channel)![1].requestId
  await vi.advanceTimersByTimeAsync(119_999)
  expect(emit).not.toHaveBeenCalledWith('prompt:expired', expect.anything())
  await vi.advanceTimersByTimeAsync(1)
  await connected
  expect(emit.mock.calls.filter(([name]) => name === 'prompt:expired')).toEqual([['prompt:expired', { requestId }]])
  hub.respondHostKey(requestId, 'save')
  hub.respondKeyboard(requestId, [])
  await vi.advanceTimersByTimeAsync(120_000)
  expect(emit.mock.calls.filter(([name]) => name === 'prompt:expired')).toHaveLength(1)
})

it.each(['hostkey:prompt', 'kbd:prompt'])('cancels %s on its connection signal, without expiring an answered request', async (channel) => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const host = vault.saveHost({ groupId: null, name: 'test', host: 'test', port: 22, username: 'u', authType: 'password' })
  vi.spyOn(connection, 'connectEndpoint').mockImplementation(async (_target, options) => {
    if (channel === 'hostkey:prompt') await options.verifyHost({ host: 'test', port: 22, fingerprint: 'test', keyType: 'test', signal: controller.signal })
    else await options.onKeyboard({ name: '', instructions: '', prompts: [], signal: controller.signal })
    throw new Error('finished')
  })
  const connected = hub.connect(host.id, 80, 24).catch(() => null)
  await vi.advanceTimersByTimeAsync(0)
  const payload = emit.mock.calls.find(([name]) => name === channel)![1]
  expect(payload).not.toHaveProperty('signal')
  if (channel === 'hostkey:prompt') hub.respondHostKey(payload.requestId, 'once')
  else hub.respondKeyboard(payload.requestId, [])
  controller.abort()
  await connected
  await vi.advanceTimersByTimeAsync(120_000)
  expect(emit).not.toHaveBeenCalledWith('prompt:expired', expect.anything())
})
