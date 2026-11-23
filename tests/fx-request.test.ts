import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestFxRates, FX_ENDPOINT, FX_RESPONSE_LIMIT, FX_TIMEOUT_MS } from '../src/main/fx-service'
vi.mock('electron', () => ({ net: { request: vi.fn() } }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
function transport(status = 200, headers: Record<string, string | string[]> = { 'content-type': 'application/json; charset=utf-8' }) {
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(), end: vi.fn() })
  const response = Object.assign(new EventEmitter(), { statusCode: status, headers })
  vi.mocked(net.request).mockReturnValue(request as unknown as Electron.ClientRequest)
  return { request, response, respond: () => request.emit('response', response) }
}
it('uses Electron system networking with a fixed URL, no credentials/cookies, no redirect or HTTP cache', async () => {
  const { request, response, respond } = transport(), pending = requestFxRates(new AbortController().signal)
  expect(net.request).toHaveBeenCalledExactlyOnceWith({ method: 'GET', url: FX_ENDPOINT, credentials: 'omit', useSessionCookies: false, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } })
  expect(request.end).toHaveBeenCalledOnce()
  respond(); response.emit('data', Buffer.from('[]')); response.emit('end')
  await expect(pending).resolves.toEqual([])
})
it.each([302, 401, 429, 500])('rejects HTTP %s without following redirects', async status => {
  const { request, respond } = transport(status), pending = requestFxRates(new AbortController().signal)
  respond(); await expect(pending).rejects.toThrow('invalid'); expect(request.abort).toHaveBeenCalledOnce()
})
it('aborts the complete request on timeout, including while waiting for a response body', async () => {
  const { request, respond } = transport(), pending = requestFxRates(new AbortController().signal)
  respond(); const rejection = expect(pending).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(FX_TIMEOUT_MS); await rejection; expect(request.abort).toHaveBeenCalledOnce()
})
it('rejects redirects, network failures, cancellation and premature close', async () => {
  for (const event of ['redirect', 'error', 'close', 'abort']) {
    const { request } = transport(), pending = requestFxRates(new AbortController().signal)
    request.emit(event, new Error('private detail')); await expect(pending).rejects.not.toThrow('private detail')
  }
  const { request } = transport(), controller = new AbortController(), pending = requestFxRates(controller.signal)
  controller.abort(); await expect(pending).rejects.toThrow('aborted'); expect(request.abort).toHaveBeenCalledOnce()
})
it.each(['text/html', 'text/plain', ''])('rejects non-JSON content %s', async type => {
  const { respond } = transport(200, { 'content-type': type }), pending = requestFxRates(new AbortController().signal)
  respond(); await expect(pending).rejects.toThrow('invalid')
})
it.each([true, false])('bounds declared and streamed response bytes (declared=%s)', async declared => {
  const { response, respond } = transport(200, { 'content-type': ['application/json'], ...(declared ? { 'content-length': String(FX_RESPONSE_LIMIT + 1) } : {}) })
  const pending = requestFxRates(new AbortController().signal); respond()
  if (!declared) response.emit('data', Buffer.alloc(FX_RESPONSE_LIMIT + 1))
  await expect(pending).rejects.toThrow('invalid')
})
it('rejects malformed JSON and incomplete bodies', async () => {
  const first = transport(), pending = requestFxRates(new AbortController().signal)
  first.respond(); first.response.emit('data', Buffer.from('{broken')); first.response.emit('end')
  await expect(pending).rejects.toThrow('invalid')
  const second = transport(), interrupted = requestFxRates(new AbortController().signal)
  second.respond(); second.response.emit('aborted'); await expect(interrupted).rejects.toThrow('network')
})
