import { EventEmitter } from 'node:events'
import type { SFTPWrapper } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
import { withEditNamespace } from '../src/main/sftp/edit-namespace'

type Done<T = unknown> = (error?: Error | null, value?: T) => void
function fixture() {
  return Object.assign(new EventEmitter(), {
    realpath: vi.fn((_path: string, done: Done<string>) => done(null, '/resolved')),
    open: vi.fn((_path: string, _flags: string, _mode: number, done: Done<Buffer>) => done(null, Buffer.from('handle'))),
    write: vi.fn((_handle: Buffer, _bytes: Buffer, _offset: number, _length: number, _position: number, done: Done) => done()),
    close: vi.fn((_handle: Buffer, done: Done) => done()),
    unlink: vi.fn((_path: string, done: Done) => done())
  })
}
afterEach(() => vi.useRealTimers())

it('proves the resolved parent with an exclusive private nonce and cleans it after the action', async () => {
  const sftp = fixture(), controller = new AbortController()
  const action = vi.fn(async (target, proof) => {
    expect(target).toBe('/resolved/file.txt')
    expect(sftp.open).toHaveBeenCalledWith(`/resolved/${proof.name}`, 'wx', 0o600, expect.any(Function))
    expect(sftp.write.mock.calls[0]![1].toString()).toBe(proof.token)
    expect(sftp.close).toHaveBeenCalledTimes(1)
    return 42
  })
  expect(await withEditNamespace(sftp as unknown as SFTPWrapper, '/alias/file.txt', controller.signal, action)).toBe(42)
  expect(sftp.unlink).toHaveBeenCalledWith(sftp.open.mock.calls[0]![0], expect.any(Function))
  expect(sftp.eventNames()).toEqual([])
})

it('times out a missing realpath callback without starting the edit', async () => {
  vi.useFakeTimers()
  const sftp = fixture(), action = vi.fn()
  sftp.realpath.mockImplementation(() => undefined)
  const result = withEditNamespace(sftp as unknown as SFTPWrapper, '/file', new AbortController().signal, action)
  const rejected = expect(result).rejects.toThrow('目录校验超时')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(action).not.toHaveBeenCalled()
  expect(sftp.eventNames()).toEqual([])
})

it('settles an aborted write even when cleanup callbacks never arrive', async () => {
  const sftp = fixture(), controller = new AbortController(), action = vi.fn()
  sftp.write.mockImplementation(() => { controller.abort() })
  sftp.close.mockImplementation(() => undefined)
  sftp.unlink.mockImplementation(() => undefined)
  await expect(withEditNamespace(sftp as unknown as SFTPWrapper, '/file', controller.signal, action)).rejects.toMatchObject({ name: 'AbortError' })
  expect(action).not.toHaveBeenCalled()
  expect(sftp.unlink).toHaveBeenCalledTimes(1)
  expect(sftp.eventNames()).toEqual([])
})

it.each(['end', 'close', 'error'])('settles a pending write on SFTP %s without starting the edit', async event => {
  const sftp = fixture(), action = vi.fn()
  sftp.write.mockImplementation(() => { sftp.emit(event, new Error('fixture disconnected')) })
  await expect(withEditNamespace(sftp as unknown as SFTPWrapper, '/file', new AbortController().signal, action)).rejects.toThrow(/连接已断开|fixture disconnected/)
  expect(action).not.toHaveBeenCalled()
  expect(sftp.unlink).toHaveBeenCalledTimes(1)
  expect(sftp.eventNames()).toEqual([])
})

it('bounds cleanup when the unlink acknowledgement is lost', async () => {
  vi.useFakeTimers()
  const sftp = fixture()
  sftp.unlink.mockImplementation(() => undefined)
  const result = withEditNamespace(sftp as unknown as SFTPWrapper, '/file', new AbortController().signal, async () => 42)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await result).toBe(42)
  expect(sftp.eventNames()).toEqual([])
})
