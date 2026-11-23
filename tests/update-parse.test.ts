import { describe, expect, it } from 'vitest'
import { compareVersions, isReleaseUrl, parseLatestRelease, RELEASE_PAGE_PREFIX } from '../src/core/updates'

const release = (tag = 'v0.4.0') => ({ tag_name: tag, html_url: `${RELEASE_PAGE_PREFIX}${tag}`, draft: false, prerelease: false, body: '修复连接问题。\n更稳定的文件传输。' })

describe('official release metadata', () => {
  it('offers a newer stable version and plain-text notes', () => {
    expect(parseLatestRelease(release(), '0.3.0')).toEqual({ status: 'available', release: {
      version: '0.4.0', url: `${RELEASE_PAGE_PREFIX}v0.4.0`, summary: '修复连接问题。\n更稳定的文件传输。'
    } })
  })
  it.each(['0.4.0', '0.4.0+build.2', '0.5.0', '1.0.0'])('does not offer a downgrade or equal precedence version to %s', (current) => {
    expect(parseLatestRelease(release(), current)).toEqual({ status: 'current' })
  })
  it('offers the stable version to a prerelease and supports encoded build metadata in its URL', () => {
    const data = { ...release('v0.4.0+build.1'), html_url: `${RELEASE_PAGE_PREFIX}v0.4.0%2Bbuild.1` }
    expect(parseLatestRelease(data, '0.4.0-rc.9')).toMatchObject({ status: 'available', release: { version: '0.4.0+build.1' } })
  })
  it.each([null, [], {}, 'release', { ...release(), draft: true }, { ...release(), prerelease: true },
    { ...release(), draft: undefined }, { ...release(), body: {} }, { ...release(), body: undefined },
    { ...release(), tag_name: 'v0.5.0' }, release('v0.5'), release('v01.2.3'), release('v0.5.0-rc.1'), release('v' + '1'.repeat(201) + '.0.0')
  ])('rejects malformed or non-stable metadata: %j', (value) => {
    expect(parseLatestRelease(value, '0.3.0')).toEqual({ status: 'error', reason: 'invalid' })
  })
  it('rejects an invalid current version instead of guessing', () => {
    expect(parseLatestRelease(release(), 'broken')).toEqual({ status: 'error', reason: 'invalid' })
  })
  it('keeps HTML/Markdown inert, removes controls, and limits the summary', () => {
    const body = '<img src=x onerror=alert(1)>\r\n[link](https://evil.test)\u001b\u202e' + '中'.repeat(3000)
    const parsed = parseLatestRelease({ ...release(), body }, '0.3.0')
    expect(parsed.status).toBe('available')
    if (parsed.status !== 'available') throw new Error('Expected newer release')
    expect(parsed.release.summary).toContain('<img src=x onerror=alert(1)>\n[link](https://evil.test)')
    expect(parsed.release.summary).not.toMatch(/[\u001b\u202e\r]/)
    expect(parsed.release.summary).toHaveLength(2001)
    expect(parsed.release.summary.endsWith('…')).toBe(true)
    expect(parseLatestRelease({ ...release(), body: null }, '0.3.0')).toMatchObject({ release: { summary: '' } })
  })
})

describe('release URL boundary', () => {
  it.each([
    'http://github.com/dadadasir/HopLine/releases/tag/v0.4.0',
    'https://github.com.evil.test/dadadasir/HopLine/releases/tag/v0.4.0',
    'https://github.com@evil.test/dadadasir/HopLine/releases/tag/v0.4.0',
    'https://user:password@github.com/dadadasir/HopLine/releases/tag/v0.4.0',
    'https://github.com:443/dadadasir/HopLine/releases/tag/v0.4.0',
    'https://github.com/other/HopLine/releases/tag/v0.4.0',
    `${RELEASE_PAGE_PREFIX}v0.4.0?download=1`, `${RELEASE_PAGE_PREFIX}v0.4.0#anything`,
    `${RELEASE_PAGE_PREFIX}v0.4.0/../../other`, `${RELEASE_PAGE_PREFIX}%2f%2fevil.test`,
    `${RELEASE_PAGE_PREFIX}v0.4.0%0a`, `${RELEASE_PAGE_PREFIX}v0.4.0\\evil`,
    'javascript:alert(1)', '//github.com/dadadasir/HopLine/releases/tag/v0.4.0', {}, null
  ])('refuses a URL outside the fixed stable-release page boundary: %j', (url) => {
    expect(isReleaseUrl(url)).toBe(false)
    expect(parseLatestRelease({ ...release(), html_url: url }, '0.3.0')).toEqual({ status: 'error', reason: 'invalid' })
  })
  it('accepts only the project stable release tag page', () => {
    expect(isReleaseUrl(`${RELEASE_PAGE_PREFIX}v0.4.0`)).toBe(true)
    expect(isReleaseUrl(`${RELEASE_PAGE_PREFIX}0.4.0`)).toBe(true)
    expect(isReleaseUrl(`${RELEASE_PAGE_PREFIX}v0.4.0-beta.1`)).toBe(false)
  })
  it('compares arbitrarily large semver components without numeric rounding', () => {
    expect(compareVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBe(1)
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1)
    expect(compareVersions('1.0.0-01', '1.0.0')).toBeNull()
  })
})
