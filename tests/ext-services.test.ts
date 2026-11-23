import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { commandServices } from '../src/main/ext/services'
import { KEYSTORE_UNREADABLE } from '../src/shared/host-secrets'
import { OpLog } from '../src/main/oplog'
import { Vault, emptyStore, MemorySecretCodec } from '../src/core/vault'
import type { HostPublic } from '../src/shared/types'
import type { ExecOptions, ExecResult } from '../src/main/ssh/exec'
let directory: string
let host: HostPublic
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-extension-services-'))
  host = { ...new Vault(emptyStore(), new MemorySecretCodec()).saveHost({ name: '测试', host: '127.0.0.1', port: 22, username: 'root', authType: 'agent', groupId: null }), id: 'host' }
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
const response = (stdout = '', code = 0): ExecResult => ({ code, signal: null, stdout, stderr: '', timedOut: false, truncated: false })
const row = { at: 1, runbookId: 'extension', stepId: 'one', title: '操作', status: 'executed' as const, reason: '完成', output: '', durationMs: 5 }
it('uses independent sudo stdin and redacts both output streams without logging secrets', async () => {
  const secret = 'canary-extension-secret'
  const exec = vi.fn(async (_id: string, command: string, options?: ExecOptions) => {
    if (command === "sh -c 'id -u'") return response('1000\n')
    if (command === "sh -c 'command -v sudo'") return response('/usr/bin/sudo\n')
    if (command === "sh -c 'sudo -k -n true'") return response('', 1)
    expect(command).not.toContain(secret)
    expect(command).toContain("sudo -k -S -p '' sh -c")
    expect(command).toContain('exec </dev/null')
    expect(options?.stdin).toBe(secret + '\n')
    return { ...response(secret), stderr: 'error ' + secret }
  })
  const services = commandServices({ exec }, id => id === 'host' ? host : undefined, new OpLog(directory))
  for (let i = 0; i < 2; i++) {
    const result = await services.execute('host', { command: 'id', sudo: true, sudoPassword: secret, timeoutMs: 5000 })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.stdout).toBe('***')
  }
  expect(exec.mock.calls.filter(([, command]) => command.startsWith('sudo -k'))).toHaveLength(2)
  expect(fs.readdirSync(directory)).toEqual([])
})
it.each([false, true])('preserves the localized keychain error for extension batch commands (sudo=%s)', async sudo => {
  const failure = new Error(KEYSTORE_UNREADABLE.en)
  const exec = vi.fn(async () => { throw failure })
  const services = commandServices({ exec }, () => host, new OpLog(directory))
  await expect(services.execute('host', { command: 'id', sudo, sudoPassword: 'keychain', timeoutMs: 5000 })).rejects.toBe(failure)
  expect(exec).toHaveBeenCalledOnce()
  expect(fs.readdirSync(directory)).toEqual([])
})

it('does not mistake a shared sudo ticket for a password-free policy', async () => {
  const exec = vi.fn(async (_id: string, command: string) => {
    if (command === "sh -c 'id -u'") return response('1000\n')
    if (command === "sh -c 'command -v sudo'") return response('/usr/bin/sudo\n')
    if (command === "sh -c 'sudo -n true'") return response() // cached ticket
    if (command === "sh -c 'sudo -k -n true'") return response('', 1) // real policy
    throw new Error('Unexpected command')
  })
  const services = commandServices({ exec }, () => host, new OpLog(directory))
  expect(await services.sudoMode('host')).toBe('password')
  await expect(services.execute('host', { command: 'id', sudo: true, timeoutMs: 5000 })).rejects.toThrow('需要 sudo 密码')
  expect(exec.mock.calls.filter(([, command]) => command === "sh -c 'sudo -k -n true'")).toHaveLength(2)
  expect(exec.mock.calls.some(([, command]) => command === 'id')).toBe(false)
})
it('redacts transport exceptions, validates inputs, and never executes deleted hosts', async () => {
  const secret = 'canary-exception-secret'
  const exec = vi.fn(async () => { throw new Error(secret) })
  const services = commandServices({ exec }, id => id === 'host' ? host : undefined, new OpLog(directory))
  await expect(services.execute('host', { command: 'id', sudo: false, sudoPassword: secret, timeoutMs: 1000 })).rejects.toThrow('***')
  exec.mockClear()
  await expect(services.execute('gone', { command: 'id', sudo: false, timeoutMs: 1000 })).rejects.toThrow('主机不存在')
  await expect(services.execute('host', { command: 'id', sudo: false, timeoutMs: 0 })).rejects.toThrow('不合法')
  await expect(services.execute('host', { command: 'id', sudo: true, sudoPassword: 'a\nb', timeoutMs: 1000 })).rejects.toThrow('不合法')
  expect(exec).not.toHaveBeenCalled()
})
it('denies missing privilege and preserves direct non-privileged command semantics', async () => {
  const exec = vi.fn(async (_id: string, command: string) => command === "sh -c 'id -u'" ? response('1000\n') : response('', 1))
  const services = commandServices({ exec }, () => host, new OpLog(directory))
  await expect(services.execute('host', { command: 'id', sudo: true, timeoutMs: 1000 })).rejects.toThrow('root')
  expect(exec.mock.calls.some(([, cmd]) => cmd === 'id')).toBe(false)
  exec.mockClear()
  await services.execute('host', { command: 'printf "hello"', sudo: false, timeoutMs: 1000 })
  expect(exec).toHaveBeenCalledExactlyOnceWith('host', 'printf "hello"', { timeoutMs: 1000, maxOutputBytes: 1024 * 1024, stdin: undefined, beforeStart: expect.any(Function) })
})
it('appends valid host records in the existing store and rejects invalid or deleted targets', () => {
  const log = new OpLog(directory), services = commandServices({ exec: vi.fn() }, id => id === 'host' ? host : undefined, log)
  services.appendOperation('host', row)
  expect(log.list('host')).toEqual([row])
  expect(() => services.appendOperation('gone', row)).toThrow('主机不存在')
  expect(() => services.appendOperation('host', { ...row, durationMs: NaN })).toThrow('不合法')
  expect(log.list('host')).toHaveLength(1)
})
it.each([false, true])('refuses a changed host at the connection-ready boundary (sudo=%s)', async sudo => {
  const sent: string[] = []
  const exec = vi.fn(async (_id: string, command: string, options?: ExecOptions) => {
    if (sudo && command === "sh -c 'id -u'") {
      options?.beforeStart?.(); sent.push(command)
      host = { ...host, host: '127.0.0.2' }
      return response('1000\n')
    }
    // Simulate an edit while an independent SSH acquisition is pending.
    await Promise.resolve()
    host = { ...host, host: '127.0.0.2' }
    options?.beforeStart?.()
    sent.push(command)
    return response()
  })
  const services = commandServices({ exec }, () => host, new OpLog(directory))
  await expect(services.execute('host', { command: 'printf reviewed', sudo, timeoutMs: 1000 })).rejects.toMatchObject({ name: 'HostChangedError' })
  expect(sent).toEqual(sudo ? ["sh -c 'id -u'"] : [])
})
