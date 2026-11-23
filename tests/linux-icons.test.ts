import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const { iconSvg, sizes } = createRequire(import.meta.url)('../scripts/linux-icon-source.cjs') as {
  iconSvg(root: string): string; sizes: number[]
}

it('keeps the Linux SVG derived from the existing Mark and its established light palette', () => {
  const svg = fs.readFileSync(path.join(root, 'build/linux/icon.svg'), 'utf8')
  expect(svg).toBe(iconSvg(root))
  expect(svg).toContain('viewBox="0 0 32 32"')
  expect(svg).toContain('stroke-width="1.7"')
  expect(svg).toContain('stroke="#4c46dc"')
  expect(svg).toContain('fill="#eeeefc"')
  expect(svg).not.toMatch(/<image|<text|<script|href=|className|currentColor/)
})

it.each(sizes)('ships a valid square %i px PNG for Linux launchers', size => {
  const bytes = fs.readFileSync(path.join(root, 'build/linux/icons', `${size}.png`))
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR')
  expect(bytes.readUInt32BE(16)).toBe(size)
  expect(bytes.readUInt32BE(20)).toBe(size)
  expect(bytes[25]).toBe(6) // RGBA preserves the original Mark's transparent margin.
  expect(bytes.toString('ascii', bytes.length - 8, bytes.length - 4)).toBe('IEND')
})
