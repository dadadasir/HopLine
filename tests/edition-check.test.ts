import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkEdition } from '../scripts/check-edition.mjs'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-edition-check-')) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
function output() {
  for (const file of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
    const target = path.join(directory, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'community output')
    fs.writeFileSync(path.join(path.dirname(target), 'edition-audit.json'), JSON.stringify({ schemaVersion: 1, edition: 'community', modules: [{ source: 'src/index.ts', private: false }], outputs: [{ file: path.basename(file), sha256: createHash('sha256').update('community output').digest('hex') }] }))
  }
}

describe('community output check', () => {
  it('rejects absent and incomplete builds instead of reporting a false success', () => {
    expect(() => checkEdition(path.join(directory, 'missing'))).toThrow()
    expect(() => checkEdition(directory)).toThrow()
    output()
    fs.unlinkSync(path.join(directory, 'preload/index.js'))
    expect(() => checkEdition(directory)).toThrow()
  })

  it('accepts complete clean output', () => {
    output()
    expect(checkEdition(directory)).toBe(true)
  })

  it.each(['main/chunks/pro.js', 'renderer/assets/pro.js', 'preload/index.js'])('finds fixture code in %s', (file) => {
    output()
    const target = path.join(directory, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'prefix HOPLINE_PRO_FIXTURE_MARKER suffix')
    expect(() => checkEdition(directory)).toThrow(target)
  })
})

it('rejects private module provenance even if no recognizable marker survives', () => {
  output()
  const file = path.join(directory, 'main/edition-audit.json')
  const audit = JSON.parse(fs.readFileSync(file, 'utf8'))
  audit.modules.push({ source: '<private>/feature.ts', private: true })
  fs.writeFileSync(file, JSON.stringify(audit))
  expect(() => checkEdition(directory)).toThrow('来源')
})
it('rejects absent provenance and post-build output replacement', () => {
  output()
  fs.unlinkSync(path.join(directory, 'main/edition-audit.json'))
  expect(() => checkEdition(directory)).toThrow()
  output()
  fs.writeFileSync(path.join(directory, 'main/index.js'), 'replaced module without marker')
  expect(() => checkEdition(directory)).toThrow('产物与来源记录不一致')
})
it('rejects private artifact markers outside the declared build chunks', () => {
  output()
  fs.writeFileSync(path.join(directory, 'renderer/private.js'), 'HOPLINE_PRIVATE_IMPLEMENTATION')
  expect(() => checkEdition(directory)).toThrow('private.js')
})
