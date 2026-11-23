import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listSnippets, saveSnippet, deleteSnippet } from '../src/main/snippets'
import { onDataNotice } from '../src/core/json-file'
import { NewerVersionError } from '../src/core/vault-migrate'
import type { SnippetInput } from '../src/shared/types'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn() }))
const file = () => path.join(state.directory, 'snippets.json')
const input: SnippetInput = { name: 'Logs', command: 'tail {{file}}\n', hostId: null }

beforeEach(() => { state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-snippets-')) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(state.directory, { recursive: true, force: true })
})

describe('snippet persistence', () => {
  it('starts empty without creating a file, then round-trips global and orphan-host snippets', () => {
    expect(listSnippets()).toEqual([])
    expect(fs.existsSync(file())).toBe(false)
    const global = saveSnippet(input)
    const orphan = saveSnippet({ ...input, hostId: 'deleted-host' })
    expect(global.id).not.toBe(orphan.id)
    expect(listSnippets()).toEqual([global, orphan])
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, snippets: [global, orphan] })
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(state.directory)).toEqual(['snippets.json'])
  })

  it('updates in place, retains creation time and permits converting orphan scope to global', () => {
    vi.useFakeTimers().setSystemTime(100)
    const saved = saveSnippet({ ...input, hostId: 'missing' })
    vi.setSystemTime(200)
    const edited = saveSnippet({ ...saved, name: 'New', hostId: null })
    expect(edited).toEqual({ ...saved, name: 'New', hostId: null, updatedAt: 200 })
    expect(listSnippets()).toEqual([edited])
  })

  it('deletes only the requested snippet and tolerates repeated deletion', () => {
    const first = saveSnippet(input)
    const second = saveSnippet(input)
    deleteSnippet(first.id)
    deleteSnippet(first.id)
    expect(listSnippets()).toEqual([second])
  })

  it('allows boundary lengths and refuses longer input without overwriting data', () => {
    const saved = saveSnippet({ ...input, name: 'a'.repeat(80), command: 'x'.repeat(4000) })
    expect(() => saveSnippet({ ...input, name: 'a'.repeat(81) })).toThrow('snippet.invalid')
    expect(() => saveSnippet({ ...input, command: 'x'.repeat(4001) })).toThrow('snippet.invalid')
    expect(listSnippets()).toEqual([saved])
  })

  it.each([null, {}, { ...input, name: ' ' }, { ...input, command: '' }, { ...input, hostId: 123 }, { ...input, hostId: '' }, { ...input, id: 1 }])('rejects malformed IPC input: %j', (bad) => {
    expect(() => saveSnippet(bad as SnippetInput)).toThrow('snippet.invalid')
    expect(fs.existsSync(file())).toBe(false)
  })

  it('rejects stale updates instead of recreating deleted snippets', () => {
    expect(() => saveSnippet({ ...input, id: 'missing' })).toThrow('snippet.missing')
  })

  it('enforces 500 records while allowing updates and new saves after deletion', () => {
    const saved = saveSnippet(input)
    const snippets = Array.from({ length: 499 }, (_, index) => ({ ...saved, id: String(index) }))
    fs.writeFileSync(file(), JSON.stringify({ version: 1, snippets }))
    const last = saveSnippet(input)
    expect(listSnippets()).toHaveLength(500)
    expect(() => saveSnippet(input)).toThrow('snippet.limit')
    saveSnippet({ ...last, name: 'Edited' })
    expect(listSnippets().at(-1)?.name).toBe('Edited')
    deleteSnippet(last.id)
    saveSnippet(input)
    expect(listSnippets()).toHaveLength(500)
  })

  it.each(['{broken', 'null', '{}', '{"version":1,"snippets":[null]}', '{"version":1,"snippets":{}}'])('quarantines malformed files and returns an empty list: %s', (raw) => {
    fs.writeFileSync(file(), raw)
    const notice = vi.fn()
    const stop = onDataNotice(notice)
    try { expect(listSnippets()).toEqual([]) } finally { stop() }
    const files = fs.readdirSync(state.directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^snippets\.corrupt-\d{14}\.json$/)
    expect(fs.readFileSync(path.join(state.directory, files[0]), 'utf8')).toBe(raw)
    expect(notice).toHaveBeenCalledWith({ kind: 'quarantined', path: path.join(state.directory, files[0]) })
    saveSnippet(input)
    expect(fs.readFileSync(path.join(state.directory, files[0]), 'utf8')).toBe(raw)
  })

  it('does not quarantine or overwrite a newer-version file', () => {
    const raw = '{"version":2,"snippets":[]}'
    fs.writeFileSync(file(), raw)
    expect(() => listSnippets()).toThrow(NewerVersionError)
    expect(() => saveSnippet(input)).toThrow(NewerVersionError)
    expect(() => deleteSnippet('id')).toThrow(NewerVersionError)
    expect(fs.readFileSync(file(), 'utf8')).toBe(raw)
    expect(fs.readdirSync(state.directory)).toEqual(['snippets.json'])
  })

  it('stops writes if quarantining the damaged file fails', () => {
    fs.writeFileSync(file(), 'broken')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('rename failed') })
    expect(() => saveSnippet(input)).toThrow('无法保留损坏的数据文件')
    expect(fs.readFileSync(file(), 'utf8')).toBe('broken')
  })

  it('keeps the prior file intact if an atomic write fails', () => {
    const saved = saveSnippet(input)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('disk failure') })
    expect(() => saveSnippet({ ...saved, name: 'Changed' })).toThrow('disk failure')
    expect(listSnippets()).toEqual([saved])
  })
})
