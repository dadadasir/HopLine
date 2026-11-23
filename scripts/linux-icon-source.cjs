const fs = require('node:fs')
const path = require('node:path')

const sizes = Object.freeze([16, 24, 32, 48, 64, 128, 256, 512])

// Derive the product icon from the existing React Mark, without inventing a
// separate shape or palette. Fail if its source stops matching these primitives.
function iconSvg(root) {
  const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/ui.tsx'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'src/renderer/src/index.css'), 'utf8')
  const mark = /export function Mark\([^]*?(<svg[^]*?<\/svg>)/.exec(source)?.[1]
  const light = /:root\s*\{([^]*?)\}/.exec(css)?.[1]
  const accent = /--accent:\s*(#[a-fA-F\d]{6});/.exec(light ?? '')?.[1]
  const soft = /--accent-soft:\s*(#[a-fA-F\d]{6});/.exec(light ?? '')?.[1]
  if (!mark || !accent || !soft) throw new Error('现有 Mark 或浅色主题颜色不可识别；请核对源文件后再生成图标。')
  const svg = mark
    .replace('className={className} aria-hidden', 'xmlns="http://www.w3.org/2000/svg" width="512" height="512"')
    .replaceAll('className="fill-accent-soft"', `fill="${soft}"`)
    .replaceAll('className="fill-accent"', `fill="${accent}"`)
    .replaceAll('stroke="currentColor"', `stroke="${accent}"`)
    .replaceAll('className="text-accent"', '')
    .replaceAll('strokeWidth=', 'stroke-width=')
    .replaceAll('strokeLinecap=', 'stroke-linecap=')
    .replace(/\s+\/>/g, '/>')
    .replace(/\n\s*/g, '\n')
  if (/className|currentColor|[{}]|<\/?(?!svg\b|rect\b|path\b|circle\b)[a-z]/.test(svg)) {
    throw new Error('Mark 包含未支持的图形或样式；不能自动生成不同的产品标识。')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`
}

module.exports = { iconSvg, sizes }
