import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('..', import.meta.url))
const markers = ['HOPLINE_PRO_FIXTURE_MARKER', 'HOPLINE_PRIVATE_IMPLEMENTATION'].map(value => Buffer.from(value))

export function checkEdition(outDir = resolve(root, 'out')) {
  // Fail closed on missing/incomplete output. Build scripts clear out/ before every build.
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    if (!statSync(resolve(outDir, entry)).isFile()) throw new Error(`构建产物缺失 / Missing build output: ${entry}`)
  }
  const matches = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && markers.some(marker => readFileSync(file).includes(marker))) matches.push(file)
    }
  }
  visit(outDir)
  if (matches.length) throw new Error(`社区版包含测试扩展 / Pro fixture found in community output:\n${matches.join('\n')}`)
  for (const target of ['main', 'preload', 'renderer']) {
    const audit = JSON.parse(readFileSync(resolve(outDir, target, 'edition-audit.json'), 'utf8'))
    if (audit.schemaVersion !== 1 || audit.edition !== 'community' || !Array.isArray(audit.modules) || !audit.modules.length ||
      audit.modules.some(row => !row || row.private !== false || typeof row.source !== 'string' || row.source.includes('<private>')) || !Array.isArray(audit.outputs) || !audit.outputs.length) throw new Error('开源构建来源检查失败 / Invalid community source audit')
    for (const output of audit.outputs) {
      if (typeof output.file !== 'string' || output.file.startsWith('/') || output.file.split(/[\\/]/).includes('..')) throw new Error('构建来源路径不合法 / Invalid build audit path')
      const content = readFileSync(resolve(outDir, target, output.file))
      if (createHash('sha256').update(content).digest('hex') !== output.sha256) throw new Error(`构建产物与来源记录不一致 / Build output changed: ${output.file}`)
    }
  }
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkEdition()
    console.log('社区版检查通过：未发现测试扩展 / Community output contains no pro fixture')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
