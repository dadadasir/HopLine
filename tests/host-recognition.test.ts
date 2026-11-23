import { expect, it } from 'vitest'
import { parseSshAddress, recognizeHostText } from '../src/core/host-recognition'
import { sshCommand } from '../src/core/connection-info'
import { orderedSelection, selectHosts } from '../src/renderer/src/logic/host-selection'
it.each([
  ['ssh -p 2200 admin@example.com', { host: 'example.com', port: 2200, username: 'admin' }],
  ['ssh example.com -p2222', { host: 'example.com', port: 2222 }],
  ['root@192.0.2.1:2222', { host: '192.0.2.1', port: 2222, username: 'root' }],
  ['ssh user@[2001:db8::1]', { host: '2001:db8::1', port: 22, username: 'user' }],
  ['user@[2001:db8::1]:2200', { host: '2001:db8::1', port: 2200, username: 'user' }],
  ['2001:db8::1', { host: '2001:db8::1', port: 22 }]
])('parses pasted SSH address %s', (text, expected) => expect(parseSshAddress(text)).toEqual(expected))
it.each(['ssh -oProxyCommand=bad host', 'ssh host rm', 'ssh -p 0 host', 'root@1.2.3.400', 'ssh $(id)', 'ssh -p 70000 host', 'ssh host\necho bad', '-user@host', 'root@host:abc'])('rejects unsupported or malformed input %s', text => expect(parseSshAddress(text)).toBeNull())
it('recognizes Chinese provisioning emails and leaves multiple IPs for the user to choose', () => {
  expect(recognizeHostText('服务器开通成功\nIPv4：192.0.2.10\nIPv6：2001:db8::10\n端口：2200\n用户名：root\n初始密码：aB!$ 123')).toEqual([
    { host: '192.0.2.10', port: 2200, username: 'root', password: 'aB!$ 123' }, { host: '2001:db8::10', port: 2200, username: 'root', password: 'aB!$ 123' }
  ])
})
it('recognizes English provisioning labels, SSH lines and duplicate/invalid IPs', () => {
  expect(recognizeHostText('Your VPS is ready\nIP Address: 198.51.100.5\nSSH Port: 2022\nUsername: ubuntu\nPassword: Temp@42!\nConnect: 198.51.100.5')).toEqual([{ host: '198.51.100.5', port: 2022, username: 'ubuntu', password: 'Temp@42!' }])
  expect(recognizeHostText('ssh -p 2222 admin@[2001:db8::1]')).toEqual([{ host: '2001:db8::1', port: 2222, username: 'admin' }])
  expect(recognizeHostText('999.1.1.1 and nothing else')).toEqual([])
})
it('formats SSH commands consistently and shell-quotes their targets', () => {
  const host = { host: 'example.test', port: 22, username: 'root', name: 'Example' }
  expect(sshCommand(host)).toBe('ssh -p 22 root@example.test')
  expect(sshCommand({ ...host, port: 2200 })).toBe('ssh -p 2200 root@example.test')
  expect(sshCommand({ ...host, username: 'a;id' })).toBe("ssh -p 22 'a;id@example.test'")
})
it('selects contiguous visible ranges and toggles Command selections without altering the order', () => {
  const order = ['a', 'b', 'c', 'd']
  expect(selectHosts(order, ['a'], 'a', 'c', true, false)).toEqual(['a', 'b', 'c'])
  expect(selectHosts(order, ['a'], 'a', 'd', false, true)).toEqual(['a', 'd'])
  expect(selectHosts(order, ['a', 'd'], 'a', 'a', false, true)).toEqual(['d'])
  expect(selectHosts(order, ['d'], 'd', 'b', true, false)).toEqual(['b', 'c', 'd'])
})

it.each([
  ['ssh -l admin -p 2201 example.com', { host: 'example.com', username: 'admin', port: 2201 }],
  ['ssh -l admin root@example.com', { host: 'example.com', username: 'root', port: 22 }],
  ['ssh -i "/path with spaces/key" -l user example.com', { host: 'example.com', username: 'user', port: 22 }]
])('accepts safe login/identity options: %s', (text, expected) => expect(parseSshAddress(text)).toEqual(expected))
it.each(['ssh -i', 'ssh -l', 'ssh -l "root invalid" host', 'ssh -oStrictHostKeyChecking=no host'])('rejects incomplete or other options: %s', text => expect(parseSshAddress(text)).toBeNull())
it.each([
  ['Username: root invalid\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: 22 }]],
  ['用户名：root;bad\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: 22 }]],
  ['Connect: ssh -p 2202 -l ubuntu 192.0.2.2\nPort: 22', [{ host: '192.0.2.2', port: 2202, username: 'ubuntu' }]],
  ['IPv6:2001:db8::5', [{ host: '2001:db8::5', port: 22 }]],
  ['ADDR:2001:db8::5', [{ host: '2001:db8::5', port: 22 }]],
  ['e:: face::1', []],
  ['IPv6:2001::5\nIPv6:fe80::1\nIPv6:1::2', [{ host: '2001::5', port: 22 }, { host: 'fe80::1', port: 22 }, { host: '1::2', port: 22 }]],
  ['word2001:db8::5', []],
  ['IP is 1.2.3.4.', [{ host: '1.2.3.4', port: 22 }]],
  ['IP is 1.2.3.4, (5.6.7.8)', [{ host: '1.2.3.4', port: 22 }, { host: '5.6.7.8', port: 22 }]],
  ['IP: 1.2.3.4:2203', [{ host: '1.2.3.4', port: 2203 }]],
  ['Panel: https://192.0.2.1:8443/path', []],
  ['面板：https://[2001:db8::5]:8443/\nIP: 192.0.2.2', [{ host: '192.0.2.2', port: 22 }]],
  ['IP: 192.0.2.1\nPanel: https://192.0.2.1:8443/path', [{ host: '192.0.2.1', port: 22 }]],
  ['http://192.0.2.1:8888 SSH: ssh -p 2203 root@192.0.2.2', [{ host: '192.0.2.2', port: 2203, username: 'root' }]],
  ['SSH 端口：22022（已修改）\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: 22022 }]],
  ['Port: custom\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: null }]],
  ['Port: 70000\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: null }]],
  ['255.255.255.0 127.1.2.3 0.0.0.0 :: ::1', []],
  ['Gateway: 192.0.2.254\n网关：192.0.2.253\nDNS: 8.8.8.8\nNetmask: 255.255.255.0\n掩码：255.0.0.0\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: 22 }]],
  ['Other: 198.51.100.1\n服务器：192.0.2.1\n地址：2001:db8::5', [{ host: '192.0.2.1', port: 22 }, { host: '2001:db8::5', port: 22 }, { host: '198.51.100.1', port: 22 }]],
  ['IP: ::ffff:192.0.2.1\nIP: 192.0.2.1', [{ host: '192.0.2.1', port: 22 }]],
  ['IP: 192.0.2.1\nIP: ::ffff:c000:201', [{ host: '192.0.2.1', port: 22 }]],
  ['kernel 5.15.0.107\nversion: 12.2.3.4\nv1.2.3.4\nVersion details build 1.2.3.4\nIP: 8.8.8.8', [{ host: '8.8.8.8', port: 22 }]],
  ['Kernel version 5.15.0.107, server IP: 1.2.3.4', [{ host: '1.2.3.4', port: 22 }]]
])('recognition regression: %s', (text, expected) => expect(recognizeHostText(text)).toEqual(expected))
it('orders batch copies by visible rows and drops collapsed/filtered selections', () => {
  expect(orderedSelection(['b', 'a', 'c'], ['c', 'b', 'hidden'])).toEqual(['b', 'c'])
})
