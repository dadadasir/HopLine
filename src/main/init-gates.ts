import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BaseAgent } from 'ssh2'
import type { Vault } from '../core/vault'
import type { GateResult, Params } from '../core/runbook/types'
import { defaultAgentSocket, expandLocalPath } from '../core/win-platform'
import type { InitIdentity, InitAuth } from '../shared/types'
import { connectEndpoint, createSshAgent, type HostCheck, type OpenedConnection } from './ssh/connect'
import { execOnClient } from './ssh/exec'

export async function listInitIdentities(socket = defaultAgentSocket()): Promise<InitIdentity[]> {
  const directory = path.join(os.homedir(), '.ssh'), identities: InitIdentity[] = []
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.pub')) : []) {
    const file = path.join(directory, name)
    try {
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 16384) continue
      identities.push({ label: name, publicKey: fs.readFileSync(file, 'utf8').trim(), auth: { type: 'privateKey', privateKeyPath: file.slice(0, -4) } })
    } catch { /* An unreadable key does not hide other identities. */ }
  }
  const target = socket?.trim() ? expandLocalPath(socket) : ''
  if (target) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      let client: BaseAgent
      try { client = createSshAgent(target) } catch { clearTimeout(timer); resolve(); return }
      client.getIdentities((error, keys) => {
        clearTimeout(timer)
        if (!error) for (const key of keys ?? []) if (typeof key === 'object' && key !== null && 'getPublicSSH' in key) identities.push({
          label: `agent: ${key.comment || key.type}`, publicKey: `${key.type} ${key.getPublicSSH().toString('base64')}`,
          auth: { type: 'agent', socket: target }
        })
        resolve()
      })
    })
  }
  return identities
}

export function validateInitAuth(auth: InitAuth): void {
  if (!auth || !['privateKey', 'agent'].includes(auth.type) ||
    (auth.type === 'privateKey' && (typeof auth.privateKeyPath !== 'string' || !auth.privateKeyPath.trim())) ||
    (auth.socket != null && typeof auth.socket !== 'string') || (auth.passphrase != null && typeof auth.passphrase !== 'string')) throw new Error('init.invalidAuth')
}

export async function loginAsNewUser(vault: Vault, hostId: string, auth: InitAuth, params: Params,
  verifyHost: (check: HostCheck) => Promise<boolean>, signal?: AbortSignal): Promise<GateResult> {
  let opened: OpenedConnection | undefined, directory: string | undefined
  try {
    validateInitAuth(auth)
    const host = vault.getHost(hostId)
    if (!host) return { ok: false, reason: '主机不存在' }
    const secrets = vault.secretsOf(hostId)
    // Pin an agent to the selected public key, never a different identity it happens to offer.
    if (auth.type === 'agent') {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-init-'))
      fs.writeFileSync(path.join(directory, 'identity.pub'), params.PUBKEY, { mode: 0o600 })
    }
    opened = await connectEndpoint({ host: host.host, port: host.port, username: params.USER,
      connectionTimeoutSec: host.connectionTimeoutSec, keepaliveIntervalSec: host.keepaliveIntervalSec,
      auth: { authType: auth.type, password: null, privateKey: null, privateKeyPath: auth.privateKeyPath ?? null,
        passphrase: auth.passphrase ?? null, agent: auth.type === 'agent' ? { socket: auth.socket ?? null, identityFile: path.join(directory!, 'identity.pub'), forward: false } : null }
    }, { signal, verifyHost, onKeyboard: async () => null,
      proxy: host.proxy ? { ...host.proxy, password: secrets.proxyPassword } : null,
      jumps: host.jumps.map((jump, index) => ({ host: jump.host, port: jump.port, username: jump.username,
        auth: { authType: jump.authType, agent: jump.agent, privateKeyPath: jump.privateKeyPath, ...secrets.jumps[index]! } }))
    })
    const result = await execOnClient(opened.client, "sudo -S -p '' -v", { stdin: `${params.USER_PASSWORD}\n`, signal })
    return result.code === 0 && !result.timedOut && !result.signal ? { ok: true } : { ok: false, reason: 'init.sudoFailed' }
  } catch { return { ok: false, reason: 'init.loginFailed' } }
  finally {
    opened?.client.end()
    for (const jump of [...(opened?.jumps ?? [])].reverse()) jump.end()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
}
