import { describe, expect, it } from 'vitest'
import { markSshConfigDuplicates, parseSshConfig, type SshConfigReader } from '../src/core/ssh-config'

const home = '/home/hop'
function parse(config: string, files: Record<string, string> = {}) {
  const all: Record<string, string> = { [`${home}/.ssh/config`]: config, ...files }
  const read: SshConfigReader = (file) => all[file] ?? null
  read.glob = (glob) => Object.keys(all).filter((file) => new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`).test(file)).reverse()
  return parseSshConfig(`${home}/.ssh/config`, read, home)
}
const byName = (result: ReturnType<typeof parse>, name: string) => result.hosts.find((host) => host.name === name)!

describe('SSH config import', () => {
  it('expands two Include levels, glob order and paths relative to ~/.ssh', () => {
    const result = parse('Include conf/*.conf\nInclude missing', {
      [`${home}/.ssh/conf/a.conf`]: 'Include nested/host\nHost *\n User first',
      [`${home}/.ssh/conf/b.conf`]: 'Host beta\n HostName beta.test\n User later',
      [`${home}/.ssh/nested/host`]: 'Host alpha\n HostName alpha.test'
    })
    expect(result.hosts.map(({ name, host, username }) => [name, host, username])).toEqual([
      ['alpha', 'alpha.test', 'first'], ['beta', 'beta.test', 'first']
    ])
    expect(result.warnings).toEqual([])
  })

  it('stops cyclic Includes and allows the same file in a different branch', () => {
    const result = parse('Include cycle\nHost good\n User ok\nInclude defaults', {
      [`${home}/.ssh/cycle`]: 'Include config',
      [`${home}/.ssh/defaults`]: 'Port 2222'
    })
    expect(byName(result, 'good').port).toBe(2222)
    expect(result.warnings.join()).toContain('Include 循环')
  })

  it('limits Include nesting to sixteen files below the entry', () => {
    const files = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [
      `${home}/.ssh/${index}`, `Host h${index}\nInclude ${index + 1}`
    ]))
    const result = parse('Include 0', files)
    expect(result.hosts).toHaveLength(16)
    expect(result.warnings.join()).toContain('超过 16 层')
  })

  it('uses the first matching value, with later wildcard defaults filling missing fields', () => {
    const result = parse('Host one\n User specific\n User ignored\nHost * !excluded\n User default\n Port 2222\nHost two excluded')
    expect(byName(result, 'one')).toMatchObject({ username: 'specific', port: 2222 })
    expect(byName(result, 'two')).toMatchObject({ username: 'default', port: 2222 })
    expect(byName(result, 'excluded')).toMatchObject({ username: '', port: 22 })
    expect(byName(parse('Host *\nUser first\nHost one\nUser later'), 'one').username).toBe('first')
  })

  it('imports each concrete alias once, ignores patterns, and handles quotes, equals and comments', () => {
    const result = parse('hOsT one two *.prod db? !bad\nHOSTNAME="a#b.test" # comment\nUser = "space user"\nPort=2200\nHost one')
    expect(result.hosts.map((host) => host.name)).toEqual(['one', 'two'])
    expect(result.hosts.every((host) => host.host === 'a#b.test' && host.username === 'space user' && host.port === 2200)).toBe(true)
  })

  it.each(['', '"'])('decodes escaped backslashes in OpenSSH words (quote=%s)', (quote) => {
    const user = String.raw`user\\name`, identity = String.raw`/keys/id\\part`
    const result = parse(`Host escaped\nUser ${quote}${user}${quote}\nIdentityFile ${quote}${identity}${quote}`, {
      [String.raw`/keys/id\part`]: 'fixture-private-key'
    })
    expect(result.hosts[0]).toMatchObject({ username: String.raw`user\name`, authType: 'privateKey', privateKeyPath: String.raw`/keys/id\part` })
  })

  it('maps 1Password with an explicit public key and expands paths', () => {
    const result = parse('Host one\nIdentityAgent "~/Library/Group Containers/agent.sock"\nIdentityFile %d/.ssh/key.pub\nIdentitiesOnly yes\nForwardAgent yes', {
      [`${home}/.ssh/key.pub`]: 'public'
    })
    expect(result.hosts[0]).toMatchObject({ authType: 'agent', privateKeyPath: null, agent: {
      socket: `${home}/Library/Group Containers/agent.sock`, identityFile: `${home}/.ssh/key.pub`, forward: true
    } })
    expect(result.warnings).toEqual([])
  })

  it.each(['~/.ssh/key', '~/.ssh/key.pub'])('uses a system agent when only the public file exists: %s', (file) => {
    expect(parse(`Host one\nIdentityFile ${file}`, { [`${home}/.ssh/key.pub`]: 'public' }).hosts[0]).toMatchObject({
      authType: 'agent', agent: { socket: null, identityFile: `${home}/.ssh/key.pub`, forward: false }
    })
  })

  it('prefers an explicit agent even if a private key exists and reads its companion public key', () => {
    expect(parse('Host one\nIdentityAgent /agent\nIdentityFile ~/.ssh/key', {
      [`${home}/.ssh/key`]: 'private', [`${home}/.ssh/key.pub`]: 'public'
    }).hosts[0]).toMatchObject({ authType: 'agent', agent: { socket: '/agent', identityFile: `${home}/.ssh/key.pub` } })
  })

  it('uses only the first private key and ignores ForwardAgent for privateKey auth', () => {
    expect(parse('Host one\nIdentityFile ~/.ssh/key\nIdentityFile /ignored\nForwardAgent yes', {
      [`${home}/.ssh/key`]: 'private'
    }).hosts[0]).toMatchObject({ authType: 'privateKey', privateKeyPath: `${home}/.ssh/key`, agent: null })
  })

  it('defaults to a system agent and warns about unresolved tokens or an unavailable identity', () => {
    expect(parse('Host one').hosts[0]).toMatchObject({ host: 'one', username: '', port: 22, authType: 'agent', agent: { socket: null, identityFile: null } })
    const result = parse('Host one\nIdentityAgent /agent/%h\nIdentityFile ~/.ssh/%r\nIdentitiesOnly yes')
    expect(result.hosts[0].agent?.socket).toBe('/agent/%h')
    expect(result.warnings.join()).toContain('未展开的占位符')
    expect(result.warnings.join()).toContain('IdentitiesOnly')
    expect(result.hosts[0].warnings).toEqual(result.warnings)
  })

  it('resolves two jump aliases with individual user, port, auth and no forwarding', () => {
    const result = parse('Host target\nProxyJump a,b\nHost a\nHostName a.test\nUser alice\nPort 2222\nIdentityAgent /agent\nForwardAgent yes\nHost b\nHostName b.test\nUser bob\nPort 2223\nIdentityFile /private', { '/private': 'key' })
    expect(byName(result, 'target').jumps).toEqual([
      { host: 'a.test', port: 2222, username: 'alice', authType: 'agent', privateKeyPath: null, agent: { socket: '/agent', identityFile: null, forward: false } },
      { host: 'b.test', port: 2223, username: 'bob', authType: 'privateKey', privateKeyPath: '/private', agent: null }
    ])
    expect(byName(result, 'target').jumpNames).toEqual(['a', 'b'])
  })

  it('recursively expands aliases without repeating shared prefixes', () => {
    const result = parse('Host target\nProxyJump a,b\nHost b\nProxyJump a\nHost a\nUser jump')
    expect(byName(result, 'target').jumpNames).toEqual(['a', 'b'])
    expect(byName(parse('Host target\nProxyJump b\nHost b\nProxyJump a\nHost a'), 'target').jumpNames).toEqual(['a', 'b'])
  })

  it('supports literal jumps, bracketed IPv6 and alias user/port overrides', () => {
    const result = parse('Host target\nProxyJump user@192.0.2.4:2222,v6@[::1]:2200,override@a:2201\nHost a\nUser original\nHostName alias.test')
    expect(byName(result, 'target').jumps.map(({ host, port, username }) => ({ host, port, username }))).toEqual([
      { host: '192.0.2.4', port: 2222, username: 'user' }, { host: '::1', port: 2200, username: 'v6' }, { host: 'alias.test', port: 2201, username: 'override' }
    ])
    expect(parse('Host direct\nProxyJump none').hosts[0].jumps).toEqual([])
  })

  it('skips hosts involved in cyclic ProxyJump references but preserves unrelated hosts', () => {
    const result = parse('Host a\nProxyJump b\nHost b\nProxyJump a\nHost good')
    expect(result.hosts.map((host) => host.name)).toEqual(['good'])
    expect(result.warnings.join()).toContain('ProxyJump 循环')
  })

  it('warns and omits ProxyCommand and entire Match blocks including their Includes', () => {
    const result = parse('Host one\nProxyCommand nc %h %p\nMatch all\nUser ignored\nInclude skipped\nHost two\nUser actual', {
      [`${home}/.ssh/skipped`]: 'Host unexpected'
    })
    expect(result.hosts.map((host) => host.name)).toEqual(['one', 'two'])
    expect(byName(result, 'one')).toMatchObject({ username: '', jumps: [] })
    expect(byName(result, 'two').username).toBe('actual')
    expect(result.warnings.join()).toContain('ProxyCommand 不受支持，已忽略')
    expect(result.warnings.join()).toContain('Match 块不受支持')
  })

  it('does not apply Includes under an unmatched Host block', () => {
    const result = parse('Host one\nInclude defaults\nHost two', { [`${home}/.ssh/defaults`]: 'User only-one' })
    expect(byName(result, 'one').username).toBe('only-one')
    expect(byName(result, 'two').username).toBe('')
  })

  it('marks duplicates only when host, port and user all match without mutating the preview', () => {
    const original = parse('Host a b\nHostName same.test\nUser hop')
    const result = markSshConfigDuplicates(original, [
      { id: 'wrong-user', host: 'same.test', port: 22, username: 'other' },
      { id: 'wrong-port', host: 'same.test', port: 2222, username: 'hop' },
      { id: 'wrong-host', host: 'other.test', port: 22, username: 'hop' },
      { id: 'exact', host: 'same.test', port: 22, username: 'hop' }
    ])
    expect(result.hosts.map((host) => host.duplicateOf)).toEqual(['exact', 'exact'])
    expect(original.hosts.every((host) => host.duplicateOf === null)).toBe(true)
  })

  it('skips invalid ports and chains beyond the storage limit', () => {
    const result = parse('Host bad\nPort zero\nHost long\nProxyJump a,b,c,d,e,f\nHost good')
    expect(result.hosts.map((host) => host.name)).toEqual(['good'])
    expect(result.warnings.join()).toContain('Port 无效')
    expect(result.warnings.join()).toContain('跳板最多 5 级')
  })
})
