import { COLLECT_SCRIPT } from '../core/collect/script'
import { parseCollect } from '../core/collect/parse'
import type { HostSnapshot } from '../shared/types'
import type { ConnectionPool } from './ssh/pool'

export async function collectHost(pool: Pick<ConnectionPool, 'exec'>, hostId: string): Promise<HostSnapshot> {
  const result = await pool.exec(hostId, 'sh -s', { stdin: COLLECT_SCRIPT, timeoutMs: 15_000, maxOutputBytes: 1 << 20 })
  if (result.timedOut) throw new Error('主机采集超时')
  if (result.signal || result.code !== 0) throw new Error(`主机采集失败: ${result.signal ?? result.code} ${result.stderr.slice(0, 200)}`)
  return parseCollect(result.stdout, Date.now())
}
