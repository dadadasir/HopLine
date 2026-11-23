/** Both sides normalize names here, so the bridge can never invoke core IPC. */
export function proChannel(name: string): `pro:${string}` {
  if (typeof name !== 'string') throw new Error('扩展通道名无效 / Invalid extension channel')
  const short = name.startsWith('pro:') ? name.slice(4) : name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(short)) {
    throw new Error('扩展通道必须是名称或 pro:<名称> / Expected a name or pro:<name>')
  }
  return `pro:${short}`
}
