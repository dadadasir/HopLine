import { expect, it } from 'vitest'
import { connectionTimingDraft } from '../src/renderer/src/logic/host-connection'
import { translate } from '../src/renderer/src/i18n'

it('distinguishes blank defaults from a disabled heartbeat and accepts decimal integer boundaries', () => {
  expect(connectionTimingDraft('', '  ')).toEqual({ connectionTimeoutSec: null, keepaliveIntervalSec: null })
  expect(connectionTimingDraft(' 5 ', '0')).toEqual({ connectionTimeoutSec: 5, keepaliveIntervalSec: 0 })
  expect(connectionTimingDraft('120', '300')).toEqual({ connectionTimeoutSec: 120, keepaliveIntervalSec: 300 })
})

it.each(['4', '121', '-5', '5.5', '1e1', '0x10', 'Infinity', 'abc'])('rejects an invalid timeout draft without coercing it to a valid value: %s', (draft) => {
  expect(() => connectionTimingDraft(draft, '')).toThrow('连接超时必须是 5 到 120 秒的整数')
})

it.each(['-1', '301', '10.1', '1e1', '0x10', 'Infinity', 'abc'])('rejects an invalid keepalive draft: %s', (draft) => {
  expect(() => connectionTimingDraft('', draft)).toThrow('心跳间隔必须是 0 到 300 秒的整数')
})

it.each(['zh', 'en'] as const)('provides labels, hints, defaults and range errors in %s', (locale) => {
  for (const key of ['host.connectionTimeout', 'host.keepaliveInterval', 'host.connectionTimeoutDefault', 'host.keepaliveDefault', 'host.connectionTimeoutHint', 'host.keepaliveHint', '连接超时必须是 5 到 120 秒的整数', '心跳间隔必须是 0 到 300 秒的整数']) {
    const text = translate(locale, key)
    expect(text.length).toBeGreaterThan(5)
    expect(text).not.toContain('host.')
    if (locale === 'zh') expect(text).toMatch(/[\u4e00-\u9fff]/)
    else expect(text).not.toMatch(/[\u4e00-\u9fff]/)
  }
})
