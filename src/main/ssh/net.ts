import net from 'node:net'

export interface ProxyEndpoint {
  type: 'socks5' | 'http'
  host: string
  port: number
  username?: string | null
  password?: string | null
}

export async function openProxySocket(
  proxy: ProxyEndpoint,
  targetHost: string,
  targetPort: number
): Promise<net.Socket> {
  if (proxy.type === 'socks5') {
    const { SocksClient } = await import('socks')
    const { socket } = await SocksClient.createConnection({
      command: 'connect',
      timeout: 20_000,
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        userId: proxy.username || undefined,
        password: proxy.password || undefined
      },
      destination: { host: targetHost, port: targetPort }
    })
    return socket
  }
  return httpConnect(proxy, targetHost, targetPort)
}

function httpConnect(proxy: ProxyEndpoint, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('代理连接超时'))
    }, 20_000)
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`]
      if (proxy.username) {
        const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64')
        lines.push(`Proxy-Authorization: Basic ${token}`)
      }
      lines.push('', '')
      socket.write(lines.join('\r\n'))
      let buf = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        const end = buf.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.off('data', onData)
        clearTimeout(timer)
        socket.off('error', fail)
        const status = buf.subarray(0, end).toString('utf8').split('\r\n')[0] ?? ''
        if (!/\s200\b/.test(status)) {
          socket.destroy()
          reject(new Error(`代理 CONNECT 失败: ${status}`))
          return
        }
        const extra = buf.subarray(end + 4)
        if (extra.length) socket.unshift(extra)
        resolve(socket)
      }
      socket.on('data', onData)
    })
  })
}
