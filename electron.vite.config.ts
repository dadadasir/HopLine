import { resolve } from 'node:path'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { editionAudit } from './scripts/edition-audit'

const root = fileURLToPath(new URL('.', import.meta.url))
const edition = process.env.HOPLINE_EDITION ?? 'community'
if (edition !== 'community' && edition !== 'pro') {
  throw new Error('HOPLINE_EDITION 必须为 community 或 pro / Expected community or pro')
}
const proDir = resolve(root, process.env.HOPLINE_PRO_DIR || 'pro')
const proMain = resolve(proDir, 'main/index.ts')
const proRenderer = resolve(proDir, 'renderer/index.ts')
if (edition === 'pro' && (!existsSync(proMain) || !existsSync(proRenderer))) {
  throw new Error(`收费版扩展缺失 / Pro extensions missing: ${proDir}. 需要 main/index.ts 和 renderer/index.ts；请设置 HOPLINE_PRO_DIR。`)
}
const define = { __HOPLINE_EDITION__: JSON.stringify(edition) }

export default defineConfig(async () => {
  const hook = resolve(proDir, 'build.cjs')
  const extra = edition === 'pro' && existsSync(hook)
    ? await (await import(pathToFileURL(hook).href)).default({ root, edition, version: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, env: process.env })
    : {}
  const defines = { ...define, ...(extra.define ?? {}) }
  const publicAliases = { '@hopline/ext': resolve(root, 'src/ext/api.ts'), '@hopline-core': resolve(root, 'src') }
  return {
  main: {
    define: defines,
    plugins: [externalizeDepsPlugin({ exclude: ['chokidar'] }), editionAudit(root, proDir, edition, extra.forbiddenSources ?? [])],
    resolve: {
      alias: {
        ...publicAliases,
        '@shared': resolve('src/shared'),
        '@hopline/pro-main': edition === 'pro' ? proMain : resolve(root, 'src/ext/community/main.ts')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), editionAudit(root, proDir, edition, extra.forbiddenSources ?? [])],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    define: defines,
    root: 'src/renderer',
    server: { fs: { allow: [root, realpathSync(resolve(root, 'node_modules')), ...(edition === 'pro' ? [proDir] : [])] } },
    plugins: [react(), {
      name: 'hopline-extension-styles', enforce: 'pre',
      transform(code: string, id: string) {
        if (edition === 'pro' && id.split('?')[0] === resolve(root, 'src/renderer/src/index.css')) return `${code}\n@source ${JSON.stringify(resolve(proDir, 'renderer'))};\n`
      }
    }, tailwindcss(), editionAudit(root, proDir, edition, extra.forbiddenSources ?? [])],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        ...publicAliases,
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src'),
        '@hopline/pro-renderer': edition === 'pro' ? proRenderer : resolve(root, 'src/ext/community/renderer.ts')
      }
    },
    build: {
      minify: true,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
  }
})
