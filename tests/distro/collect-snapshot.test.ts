import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { parseCollect } from '../../src/core/collect/parse'

import { DISTROS } from './harness'

const root = path.join(import.meta.dirname, 'fixtures')
it('snapshots every synthetic distro collection', async () => {
  for (const distro of DISTROS) {
    const snapshot = parseCollect(fs.readFileSync(path.join(root, distro, 'collect.txt'), 'utf8'), Date.UTC(2026, 9, 27))
    await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot(path.join(root, distro, 'collect.snapshot.json'))
  }
})
