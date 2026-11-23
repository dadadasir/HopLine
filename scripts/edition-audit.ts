import { createHash } from 'node:crypto'
import { existsSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

export function editionAudit(root: string, privateRoot: string, edition: string, forbiddenSources: string[] = []): Plugin {
  const canonical = (file: string) => existsSync(file) ? realpathSync(file) : resolve(file)
  const project = canonical(root), privateDirectory = canonical(privateRoot), dependencies = canonical(resolve(root, 'node_modules'))
  const forbidden = forbiddenSources.map(canonical)
  const inside = (file: string, directory: string) => file === directory || file.startsWith(directory + sep)
  let sources: { source: string; private: boolean }[] = []
  return {
    name: 'hopline-edition-audit', enforce: 'post',
    generateBundle(_options, bundle) {
      const modules = [...this.getModuleIds()].filter(id => isAbsolute(id.split('?')[0])).map(id => {
        const file = canonical(id.split('?')[0]), dependency = inside(file, dependencies)
        if (forbidden.some(directory => inside(file, directory))) this.error('构建引用了禁止打包的本地资料 / Build imported excluded local material')
        const privateModule = !dependency && (inside(file, privateDirectory) || !inside(file, project))
        const source = dependency ? `node_modules/${relative(dependencies, file)}` : privateModule ? `<private>/${relative(privateDirectory, file)}` : relative(project, file)
        return { source, private: privateModule }
      }).sort((a, b) => a.source.localeCompare(b.source))
      sources = modules
      if (edition === 'community' && modules.some(module => module.private)) this.error('开源构建引用了私有目录 / Community build imported private sources')
      // A second, artifact-level signature makes accidental private chunks detectable.
      if (modules.some(module => module.private)) {
        for (const output of Object.values(bundle)) if (output.type === 'chunk') output.code = `/* HOPLINE_PRIVATE_IMPLEMENTATION */\n${output.code}`
      }
      const outputs = Object.values(bundle).map(output => ({ file: output.fileName, sha256: createHash('sha256').update(output.type === 'chunk' ? output.code : output.source).digest('hex') }))
      this.emitFile({ type: 'asset', fileName: 'edition-audit.json', source: JSON.stringify({ schemaVersion: 1, edition, modules, outputs }) })
    },
    writeBundle(options, bundle) {
      if (!options.dir) this.error('构建输出目录缺失 / Build output directory missing')
      // Vite/Rolldown may finalize URLs/code after generateBundle. Hash the
      // actual written artifacts, while retaining the resolved module evidence.
      const outputs = Object.values(bundle).filter(output => output.fileName !== 'edition-audit.json').map(output => ({
        file: output.fileName, sha256: createHash('sha256').update(readFileSync(resolve(options.dir!, output.fileName))).digest('hex')
      }))
      writeFileSync(resolve(options.dir, 'edition-audit.json'), JSON.stringify({ schemaVersion: 1, edition, modules: sources, outputs }))
    }
  }
}
