import type { HostPublic, Locale } from '../shared/types'

function shellWord(value: string): string {
  return /^[\w.@:[\]%-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
export function sshCommand(host: Pick<HostPublic, 'host' | 'port' | 'username'>): string {
  const target = `${host.username}@${host.host}`
  return `ssh -p ${host.port} ${target.startsWith('-') ? '-- ' : ''}${shellWord(target)}`
}

export function connectionCard(host: Pick<HostPublic, 'name' | 'meta' | 'host' | 'port' | 'username' | 'authType'>, password: string | null, locale: Locale): string {
  const note = host.meta.note?.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').trim()
  const zh = locale === 'zh'
  const authentication = host.authType === 'privateKey' ? (zh ? '私钥' : 'Private key')
    : host.authType === 'agent' ? 'SSH Agent' : zh ? '交互' : 'Interactive'
  if (zh) return [
    `名称：${host.name}${note ? `（备注：${note}）` : ''}`,
    `IP：${host.host}`, `端口：${host.port}`, `用户名：${host.username}`,
    password ? `密码：${password}` : `认证：${authentication}`
  ].join('\n')
  return [
    `Name: ${host.name}${note ? ` (Note: ${note})` : ''}`,
    `IP: ${host.host}`, `Port: ${host.port}`, `Username: ${host.username}`,
    password ? `Password: ${password}` : `Auth: ${authentication}`
  ].join('\n')
}
