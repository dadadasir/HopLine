import fs from 'node:fs'
import path from 'node:path'
import { renameReplaceSync } from '../core/win-platform'

export class ShellIntegrationStore {
  private readonly file: string
  constructor(directory: string) { this.file = path.join(directory, 'shell-integration.json') }
  private read(): string[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []; throw error }
  }
  has(hostId: string): boolean { return this.read().includes(hostId) }
  set(hostId: string, installed: boolean): void {
    const ids = new Set(this.read())
    if (installed) ids.add(hostId); else ids.delete(hostId)
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify([...ids]), { mode: 0o600 })
    renameReplaceSync(`${this.file}.tmp`, this.file)
  }
  prune(exists: (hostId: string) => boolean): void { for (const id of this.read()) if (!exists(id)) this.set(id, false) }
}
