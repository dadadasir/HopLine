import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { describeDistros, DISTRO_DIR } from './harness'
import { execSsh } from './ssh'

const probe = process.env.HOPLINE_CAPTURE_PROBE
if (!probe || !/^[a-z][a-z0-9-]*$/.test(probe)) throw new Error('探测脚本名无效，请使用 npm run distro:capture -- basic')
const script = await readFile(path.join(DISTRO_DIR, 'probes', `${probe}.sh`), 'utf8')

describeDistros('all', (target) => {
  it(`保存 ${probe} 的真实输出`, async () => {
    const result = await execSsh(target(), target().users.ops, 'sh -s', script)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('===HOPLINE:')
    if (result.stderr) console.info(`${target().name} 探测提示：${result.stderr.trim()}`)
    const directory = path.join(DISTRO_DIR, 'fixtures', target().name)
    await mkdir(directory, { recursive: true })
    const destination = path.join(directory, `${probe}.txt`)
    const temporary = `${destination}.${process.pid}.tmp`
    try {
      await writeFile(temporary, result.stdout)
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
    console.info(`已保存 ${path.relative(process.cwd(), destination)}`)
  })
})
