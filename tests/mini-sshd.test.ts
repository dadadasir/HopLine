import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { utils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2')

describe('mini SSH host key', () => {
  let workspace: string
  const servers: Array<{ close(): Promise<void> }> = []

  beforeEach(() => {
    vi.resetModules()
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-hostkey-'))
  })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    vi.restoreAllMocks()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('retries a malformed host key and reuses the validated key for later servers', async () => {
    let valid = utils.generateKeyPairSync('ed25519')
    for (let attempt = 0; utils.parseKey(valid.private) instanceof Error && attempt < 20; attempt++) {
      valid = utils.generateKeyPairSync('ed25519')
    }
    expect(utils.parseKey(valid.private)).not.toBeInstanceOf(Error)
    const generate = vi.spyOn(utils, 'generateKeyPairSync')
      .mockReturnValue(valid)
      .mockReturnValueOnce({ private: 'invalid private key', public: '' })
    const { startMiniSshd } = await import('./support/mini-sshd.mjs')
    servers.push(await startMiniSshd({ root: path.join(workspace, 'first') }))
    servers.push(await startMiniSshd({ root: path.join(workspace, 'second') }))
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('stops after five malformed host keys', async () => {
    const generate = vi.spyOn(utils, 'generateKeyPairSync').mockReturnValue({ private: 'invalid private key', public: '' })
    const { startMiniSshd } = await import('./support/mini-sshd.mjs')
    await expect(startMiniSshd({ root: workspace })).rejects.toThrow()
    expect(generate).toHaveBeenCalledTimes(5)
  })
})
