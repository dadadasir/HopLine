import { EventEmitter } from 'node:events'
import https from 'node:https'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestLatestRelease, UPDATE_ENDPOINT, UPDATE_RESPONSE_LIMIT, UPDATE_TIMEOUT_MS } from '../src/main/update-service'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function transport(status = 200, headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }) {
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  const response = Object.assign(new PassThrough(), { statusCode: status, headers })
  let respond!: () => void
  const get = vi.spyOn(https, 'get').mockImplementation(((_url: unknown, _options: unknown, callback: (r: unknown) => void) => {
    respond = () => callback(response)
    return request
  }) as unknown as typeof https.get)
  return { request, response, get, respond: () => respond() }
}

it('requests only the fixed public API with static headers, no account/host data and no cookie jar', async () => {
  const { get, response, respond } = transport(), signal = new AbortController().signal
  const pending = requestLatestRelease(signal)
  expect(get.mock.calls[0].slice(0, 2)).toEqual([UPDATE_ENDPOINT, {
    signal, agent: false, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HopLine' }
  }])
  respond(); response.end('{"tag_name":"v1.0.0"}')
  await expect(pending).resolves.toEqual({ tag_name: 'v1.0.0' })
  expect(get).toHaveBeenCalledTimes(1)
})

it.each([[404, 'unavailable'], [403, 'rate-limit'], [429, 'rate-limit'], [500, 'network'], [302, 'network']])('handles HTTP %s without reading error bodies or following redirects', async (status, reason) => {
  const { response, respond, get } = transport(status as number, { location: 'https://evil.test', 'content-type': 'application/json' })
  const pending = requestLatestRelease(new AbortController().signal)
  respond()
  await expect(pending).rejects.toMatchObject({ reason })
  expect(response.destroyed).toBe(true)
  expect(get).toHaveBeenCalledTimes(1)
})

it('times out the entire request and closes it even if no socket inactivity event occurs', async () => {
  const { request } = transport()
  const pending = requestLatestRelease(new AbortController().signal)
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'timeout' })
  await vi.advanceTimersByTimeAsync(UPDATE_TIMEOUT_MS)
  await rejected
  expect(request.destroy).toHaveBeenCalledOnce()
})

it('classifies network errors without surfacing their sensitive details', async () => {
  const { request } = transport()
  const pending = requestLatestRelease(new AbortController().signal)
  request.emit('error', new Error('private proxy host and credentials'))
  await expect(pending).rejects.toMatchObject({ message: 'network', reason: 'network' })
})

it.each(['text/html', 'text/plain', ''])('rejects a non-JSON content type: %s', async (type) => {
  const { response, respond } = transport(200, { 'content-type': type })
  const pending = requestLatestRelease(new AbortController().signal)
  respond()
  await expect(pending).rejects.toMatchObject({ reason: 'invalid' })
  expect(response.destroyed).toBe(true)
})

it('rejects invalid JSON and incomplete bodies', async () => {
  const first = transport()
  const badJson = requestLatestRelease(new AbortController().signal)
  first.respond(); first.response.end('{broken')
  await expect(badJson).rejects.toMatchObject({ reason: 'invalid' })
  const second = transport()
  const interrupted = requestLatestRelease(new AbortController().signal)
  second.respond(); second.response.emit('aborted')
  await expect(interrupted).rejects.toMatchObject({ reason: 'network' })
})

it.each([true, false])('bounds response bytes before parsing (declared length: %s)', async (declared) => {
  const { response, respond } = transport(200, { 'content-type': 'application/json', ...(declared ? { 'content-length': String(UPDATE_RESPONSE_LIMIT + 1) } : {}) })
  const pending = requestLatestRelease(new AbortController().signal)
  respond()
  if (!declared) response.write(Buffer.alloc(UPDATE_RESPONSE_LIMIT + 1))
  await expect(pending).rejects.toMatchObject({ reason: 'invalid' })
  expect(response.destroyed).toBe(true)
})
