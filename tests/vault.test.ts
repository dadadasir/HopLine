import { describe, expect, it } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'

const SECRET = 's3cret-hop-password'

function vault() {
  return new Vault(emptyStore(), new MemorySecretCodec())
}

describe('vault store', () => {
  it('stores secrets outside the public record and the persisted json', () => {
    const store = vault()
    const group = store.saveGroup({ name: '生产' })
    const saved = store.saveHost({
      groupId: group.id,
      name: 'edge',
      host: '10.0.8.2',
      port: 22,
      username: 'root',
      authType: 'password',
      password: SECRET,
      proxy: {
        type: 'socks5',
        host: '127.0.0.1',
        port: 1080,
        username: 'proxy',
        password: 'proxy-secret'
      },
      jumps: [{
        host: '10.0.0.1',
        port: 22,
        username: 'jump',
        authType: 'privateKey',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n',
        passphrase: 'jump-pass'
      }]
    })
    expect(saved.hasPassword).toBe(true)
    expect(saved.proxy?.hasPassword).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    const raw = JSON.stringify(store.snapshot())
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('proxy-secret')
    expect(raw).not.toContain('jump-pass')
    expect(raw).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(store.secretsOf(saved.id).password).toBe(SECRET)
  })

  it('keeps a secret when an edit omits it and clears it on null', () => {
    const store = vault()
    const saved = store.saveHost({
      groupId: null,
      name: 'api',
      host: '10.0.0.4',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey',
      privateKeyPath: '/Users/example-fixture/.ssh/id_ed25519',
      passphrase: 'keep-me'
    })
    const edited = store.saveHost({
      id: saved.id,
      groupId: null,
      name: 'api-1',
      host: '10.0.0.4',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey'
    })
    expect(edited.name).toBe('api-1')
    expect(edited.hasPassphrase).toBe(true)
    expect(edited.privateKeyPath).toBe('/Users/example-fixture/.ssh/id_ed25519')
    expect(store.secretsOf(saved.id).passphrase).toBe('keep-me')
    store.saveHost({
      id: saved.id,
      groupId: null,
      name: 'api-1',
      host: '10.0.0.4',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey',
      passphrase: null
    })
    expect(store.secretsOf(saved.id).passphrase).toBeNull()
  })

  it('duplicates in the main store without returning secrets', () => {
    const store = vault()
    const saved = store.saveHost({
      groupId: null,
      name: '日志机',
      host: '10.1.0.6',
      port: 22,
      username: 'ops',
      authType: 'password',
      password: SECRET
    })
    const copy = store.duplicateHost(saved.id)
    expect(copy.id).not.toBe(saved.id)
    expect(copy.hasPassword).toBe(true)
    expect(JSON.stringify(copy)).not.toContain(SECRET)
    expect(store.secretsOf(copy.id).password).toBe(SECRET)
  })

  it('moves hosts out of a deleted group and merges a portable vault', () => {
    const store = vault()
    const group = store.saveGroup({ name: '实验' })
    const saved = store.saveHost({
      groupId: group.id,
      name: 'gpu',
      host: '192.168.4.20',
      port: 22,
      username: 'lab',
      authType: 'keyboard-interactive',
      password: SECRET
    })
    store.deleteGroup(group.id)
    expect(store.listHosts()[0]?.groupId).toBeNull()
    const portable = store.exportPortable('2026-10-26T00:00:00.000Z')
    expect(portable.hosts[0]?.password).toBe(SECRET)
    expect(JSON.stringify(store.snapshot())).not.toContain(SECRET)

    const other = vault()
    other.saveHost({
      groupId: null,
      name: 'local-only',
      host: '127.0.0.1',
      port: 22,
      username: 'me',
      authType: 'password'
    })
    other.importPortable(portable, 'merge')
    expect(other.listHosts()).toHaveLength(2)
    expect(other.secretsOf(saved.id).password).toBe(SECRET)

    const replaced = vault()
    replaced.saveHost({
      groupId: null,
      name: 'gone',
      host: '10.9.9.9',
      port: 22,
      username: 'x',
      authType: 'password',
      password: 'should-vanish'
    })
    replaced.importPortable(portable, 'replace')
    expect(replaced.listHosts().map((host) => host.name)).toEqual(['gpu'])
    expect(JSON.stringify(replaced.snapshot())).not.toContain('should-vanish')
  })

  it('rejects an incomplete portable payload and a bad port', () => {
    const store = vault()
    expect(() => store.importPortable({} as never, 'merge')).toThrow(/无法识别/)
    expect(() =>
      store.saveHost({
        groupId: null,
        name: 'bad',
        host: '10.0.0.1',
        port: 0,
        username: 'root',
        authType: 'password'
      })
    ).toThrow(/端口/)
  })
})
