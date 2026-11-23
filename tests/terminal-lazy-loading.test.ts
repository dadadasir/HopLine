import { PassThrough } from 'node:stream'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToPipeableStream } from 'react-dom/server'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import { afterEach, expect, it, vi } from 'vitest'
import { DeferredTerminalStack } from '../src/renderer/src/components/DeferredTerminalStack'
import { getState, patch } from '../src/renderer/src/state/store'
import { attachTerminal, detachTerminal, terminalOf, writeTerminal } from '../src/renderer/src/terminal/registry'

const initial = getState()
const aborts: (() => void)[] = []
afterEach(() => {
  aborts.splice(0).forEach(abort => abort())
  detachTerminal('delayed-ssh')
  detachTerminal('delayed-local')
  patch(initial)
})

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function render(node: ReactNode) {
  const output = new PassThrough(), shell = deferred<void>(), ended = deferred<void>()
  let html = ''
  const errors: unknown[] = []
  output.on('data', data => { html += String(data) })
  output.on('end', () => ended.resolve())
  output.on('error', error => ended.reject(error))
  // An explicit host shell lets React stream the pending boundary immediately.
  const stream = renderToPipeableStream(createElement('main', null, node), {
    onShellReady() { stream.pipe(output); shell.resolve() },
    onShellError(error) { shell.reject(error) },
    onError(error) { errors.push(error) }
  })
  aborts.push(() => stream.abort())
  const waitForHtml = (text: string): Promise<void> => {
    if (html.includes(text)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = () => { output.off('data', check); output.off('end', finish); output.off('error', fail) }
      const check = () => { if (html.includes(text)) { cleanup(); resolve() } }
      const fail = (error: unknown) => { cleanup(); reject(error) }
      const finish = () => { if (html.includes(text)) { cleanup(); resolve() } else fail(new Error(`Stream ended before ${text}`)) }
      if (output.readableEnded) { finish(); return }
      output.on('data', check); output.once('end', finish); output.once('error', fail)
    })
  }
  return { shell: shell.promise, ended: ended.promise, waitForHtml, html: () => html, errors, abort: () => stream.abort() }
}

it.each(['zh', 'en'] as const)('shows a %s loading state and delivers early SSH/PTY chunks in order when loading completes', async language => {
  patch({ settings: { ...initial.settings!, language } })
  const pending = deferred<{ TerminalStack: ComponentType }>()
  const load = vi.fn(() => pending.promise)
  const ssh = { write: vi.fn(), dispose: vi.fn() }, local = { write: vi.fn(), dispose: vi.fn() }
  const view = render(createElement(DeferredTerminalStack, { load }))
  await view.shell
  await view.waitForHtml(language === 'en' ? 'Loading terminal…' : '正在加载终端…')
  expect(view.html()).toContain('role="status"')
  expect(view.html()).toContain(language === 'en' ? 'Loading terminal…' : '正在加载终端…')
  expect(load).toHaveBeenCalledTimes(1)
  expect(terminalOf('delayed-ssh')).toBeUndefined()
  const first = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]), second = new TextEncoder().encode('SSH ready\r\n')
  writeTerminal('delayed-ssh', first)
  writeTerminal('delayed-local', 'local prompt ')
  writeTerminal('delayed-ssh', second)
  writeTerminal('delayed-local', '中文\r\n')
  // The test pane attaches at render time so the Node stream can exercise the
  // real Suspense scheduling and registry without a browser or xterm canvas.
  pending.resolve({ TerminalStack: () => {
    attachTerminal('delayed-ssh', ssh as unknown as Terminal, {} as SearchAddon)
    attachTerminal('delayed-local', local as unknown as Terminal, {} as SearchAddon)
    return createElement('span', null, 'terminals attached')
  } })
  await view.ended
  expect(view.errors).toEqual([])
  expect(ssh.write.mock.calls).toEqual([[first], [second]])
  expect(local.write.mock.calls).toEqual([['local prompt '], ['中文\r\n']])
  writeTerminal('delayed-ssh', 'later')
  expect(ssh.write).toHaveBeenLastCalledWith('later')
  expect(load).toHaveBeenCalledTimes(1)
})

it('allows a boundary remount to retry a failed import instead of caching its rejection on a shared lazy type', async () => {
  const first = deferred<{ TerminalStack: ComponentType }>()
  const stack = vi.fn(() => createElement('span', null, 'retry succeeded'))
  const load = vi.fn<() => Promise<{ TerminalStack: ComponentType }>>()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue({ TerminalStack: stack })
  const failed = render(createElement(DeferredTerminalStack, { load }))
  await failed.shell
  const error = new Error('temporary chunk load failure')
  first.reject(error)
  await failed.ended
  expect(failed.errors).toContain(error)
  const retry = render(createElement(DeferredTerminalStack, { load }))
  await retry.ended
  expect(retry.errors).toEqual([])
  expect(retry.html()).toContain('retry succeeded')
  expect(load).toHaveBeenCalledTimes(2)
})

it('does not mount a terminal after its waiting view has been discarded', async () => {
  const pending = deferred<{ TerminalStack: ComponentType }>()
  const stack = vi.fn(() => createElement('span', null, 'must not appear'))
  const view = render(createElement(DeferredTerminalStack, { load: () => pending.promise }))
  await view.shell
  view.abort()
  await view.ended
  pending.resolve({ TerminalStack: stack })
  await pending.promise
  await new Promise(resolve => setImmediate(resolve))
  expect(stack).not.toHaveBeenCalled()
  expect(view.html()).not.toContain('must not appear')
})
