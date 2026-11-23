import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectEndpoint, openShell } from '../src/main/ssh/connect'
import { downloadFile, listDirectory, mkdirp, statPath, uploadFile } from '../src/main/sftp/ops'
import { generateAgentKey } from './support/mini-agent.mjs'
import { startMiniSshd } from './support/mini-sshd.mjs'
import type { SFTPWrapper } from 'ssh2'

describe('loopback ssh', () => {
  it('opens a shell and replaces SFTP files when uploading and downloading', async () => {
    const server = await startMiniSshd({ username: 'hop', password: 'hop-secret' })
    const opened = await connectEndpoint(
      {
        host: '127.0.0.1',
        port: server.port,
        username: 'hop',
        auth: {
          authType: 'password',
          password: 'hop-secret',
          privateKey: null,
          privateKeyPath: null,
          passphrase: null
        }
      },
      { verifyHost: async () => true, onKeyboard: async () => null }
    )
    try {
      const shell = await openShell(opened.client, 80, 24)
      const banner = await readOnce(shell)
      expect(banner).toContain('hop-shell-ready')

      const sftp = await openSftp(opened.client)
      const listing = await listDirectory(sftp, '/')
      expect(listing.map((entry) => entry.name).sort()).toEqual(['notes', 'readme.txt'])
      expect(listing.find((entry) => entry.name === 'notes')?.isDirectory).toBe(true)

      const local = path.join(os.tmpdir(), `hopline-up-${process.pid}.bin`)
      const remote = '/payload.bin'
      fs.writeFileSync(local, Buffer.alloc(4096, 1))
      await uploadFile(sftp, local, remote, progress())
      fs.appendFileSync(local, Buffer.alloc(4096, 2))
      await uploadFile(sftp, local, remote, progress())
      const remoteStat = await statPath(sftp, remote)
      expect(remoteStat?.size).toBe(8192)

      const downloaded = path.join(os.tmpdir(), `hopline-down-${process.pid}.bin`)
      await downloadFile(sftp, remote, downloaded, progress())
      expect(fs.readFileSync(downloaded).equals(fs.readFileSync(local))).toBe(true)

      const partial = path.join(os.tmpdir(), `hopline-partial-${process.pid}.bin`)
      fs.writeFileSync(partial, fs.readFileSync(downloaded).subarray(0, 1000))
      await downloadFile(sftp, remote, partial, progress())
      expect(fs.readFileSync(partial).equals(fs.readFileSync(local))).toBe(true)

      await mkdirp(sftp, '/nested/dir')
      const nested = await statPath(sftp, '/nested/dir')
      expect(nested?.isDirectory).toBe(true)
      fs.rmSync(local, { force: true })
      fs.rmSync(downloaded, { force: true })
      fs.rmSync(partial, { force: true })
    } finally {
      opened.client.end()
      await server.close()
    }
  })

  it('accepts a private key', async () => {
    const keys = generateAgentKey()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-ssh-public-key-'))
    try {
      const publicKey = path.join(directory, 'fixture.pub')
      fs.writeFileSync(publicKey, keys.public)
      const server = await startMiniSshd({ username: 'hop', publicKey })
      try {
        const opened = await connectEndpoint(
          {
            host: '127.0.0.1',
            port: server.port,
            username: 'hop',
            auth: {
              authType: 'privateKey',
              password: null,
              privateKey: keys.private,
              privateKeyPath: null,
              passphrase: null
            }
          },
          { verifyHost: async () => true, onKeyboard: async () => null }
        )
        try {
          const shell = await openShell(opened.client, 40, 12)
          expect(await readOnce(shell)).toContain('hop-shell-ready')
        } finally {
          opened.client.end()
        }
      } finally {
        await server.close()
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

function progress() {
  return { signal: new AbortController().signal, onProgress: () => undefined }
}

function openSftp(client: { sftp: (cb: (error: Error | undefined, sftp?: SFTPWrapper) => void) => void }): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error || !sftp) reject(error ?? new Error('sftp'))
      else resolve(sftp)
    })
  })
}

function readOnce(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shell timeout')), 5000)
    stream.once('data', (data) => {
      clearTimeout(timer)
      resolve(Buffer.from(data).toString('utf8'))
    })
  })
}
