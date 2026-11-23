import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../core/json-file'
import type { VersionChange } from '../shared/api'

import { compareVersions, parseVersion } from '../core/updates'
export { compareVersions } from '../core/updates'

export function checkVersion(userData: string, current: string): VersionChange | null {
  if (!parseVersion(current)) return null
  const file = path.join(userData, 'last-version.json')
  let previous: unknown
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8'))?.version } catch { /* Missing or damaged history is a first install. */ }
  // An unchanged version needs no durable write on the startup path.
  if (previous === current) return null
  const upgraded = typeof previous === 'string' && compareVersions(current, previous) === 1
  try { writeJsonFile(file, { version: current }) } catch { return null }
  return upgraded ? { previous: previous as string, current } : null
}
