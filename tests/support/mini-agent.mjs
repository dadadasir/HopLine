import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'

const { utils } = ssh2

const uint32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes }
const string = (value) => { const bytes = Buffer.from(value); return Buffer.concat([uint32(bytes.length), bytes]) }

export function generateAgentKey() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) return pair
  }
  throw new Error('无法生成有效的测试 agent 密钥（已重试 5 次）')
}

/** Minimal OpenSSH agent: list public keys and sign with in-memory test keys. */
export async function startMiniAgent(privateKeys) {
  const keys = privateKeys.map((value) => {
    const parsed = utils.parseKey(value)
    if (parsed instanceof Error) throw parsed
    return Array.isArray(parsed) ? parsed[0] : parsed
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-agent-'))
  const socket = path.join(directory, 'a.sock')
  const clients = new Set()
  const signedKeys = []
  let identityRequests = 0
  const server = createServer((client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    let pending = Buffer.alloc(0)
    client.on('data', (data) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
        const size = pending.readUInt32BE(0)
        const request = pending.subarray(4, 4 + size)
        pending = pending.subarray(4 + size)
        let response = Buffer.from([5])
        if (request[0] === 11) {
          identityRequests++
          response = Buffer.concat([Buffer.from([12]), uint32(keys.length),
            ...keys.flatMap((key, index) => [string(key.getPublicSSH()), string(`key-${index}`)])])
        } else if (request[0] === 13) {
          let offset = 1
          const readString = () => {
            const length = request.readUInt32BE(offset)
            offset += 4
            const value = request.subarray(offset, offset + length)
            offset += length
            return value
          }
          const blob = readString()
          const payload = readString()
          const flags = request.readUInt32BE(offset)
          const key = keys.find((entry) => entry.getPublicSSH().equals(blob))
          if (key) {
            const hash = key.type === 'ssh-rsa' ? (flags & 4 ? 'sha512' : flags & 2 ? 'sha256' : 'sha1') : undefined
            const algorithm = hash === 'sha512' ? 'rsa-sha2-512' : hash === 'sha256' ? 'rsa-sha2-256' : key.type
            const signature = key.sign(payload, hash)
            if (!(signature instanceof Error)) {
              signedKeys.push(blob)
              response = Buffer.concat([Buffer.from([14]), string(Buffer.concat([string(algorithm), string(signature)]))])
            }
          }
        }
        client.write(Buffer.concat([uint32(response.length), response]))
      }
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    socket, signedKeys,
    get identityRequests() { return identityRequests },
    close: async () => {
      for (const client of clients) client.destroy()
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}
