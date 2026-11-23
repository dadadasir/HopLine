import type { UpdateCheckResult } from '../shared/updates'

export const RELEASE_PAGE_PREFIX = 'https://github.com/dadadasir/HopLine/releases/tag/'

export function parseVersion(version: string) {
  if (version.length > 200) return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(version)
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null
  return { core: match.slice(1, 4).map(BigInt), pre }
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left), b = parseVersion(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx !== ny) return nx ? -1 : 1
    return nx ? (BigInt(x) > BigInt(y) ? 1 : -1) : (x > y ? 1 : -1)
  }
  return 0
}

function releaseTag(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 512 || !url.startsWith(RELEASE_PAGE_PREFIX)) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash) return null
    const tag = decodeURIComponent(url.slice(RELEASE_PAGE_PREFIX.length))
    const version = parseVersion(tag.replace(/^v/, ''))
    return version && !version.pre.length ? tag : null
  } catch { return null }
}

/** No arbitrary external destination crosses the update-specific IPC boundary. */
export function isReleaseUrl(url: unknown): url is string {
  return releaseTag(url) !== null
}

export function parseLatestRelease(value: unknown, current: string): UpdateCheckResult {
  const invalid: UpdateCheckResult = { status: 'error', reason: 'invalid' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid
  const release = value as Record<string, unknown>
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' ||
    (release.body !== null && typeof release.body !== 'string')) return invalid
  const tag = releaseTag(release.html_url)
  if (!tag || tag !== release.tag_name) return invalid
  const version = tag.replace(/^v/, '')
  const compared = compareVersions(version, current)
  if (compared === null) return invalid
  if (compared <= 0) return { status: 'current' }
  // Keep Markdown/HTML as inert text. Remove control and bidi formatting chars;
  // rendering must use a text node, never HTML or a Markdown link renderer.
  const summary = (release.body ?? '').toString().replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  return { status: 'available', release: {
    version, url: release.html_url as string,
    summary: summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary
  } }
}
