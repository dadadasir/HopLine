import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { editContent, EDIT_LIMIT } from '../src/main/sftp/edit-content'

it('accepts the size boundary and hashes every byte without retaining remote contents', async () => {
  const bytes = Buffer.alloc(EDIT_LIMIT, 0x61)
  const result = await editContent(Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]), new AbortController().signal)
  expect(result.digest).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(result.content.length).toBe(0)
})

it('rejects excess actual bytes and releases the source', async () => {
  const source = Readable.from([Buffer.alloc(EDIT_LIMIT), Buffer.from('x')])
  await expect(editContent(source, new AbortController().signal, true)).rejects.toThrow('文件超过 20 MB')
  expect(source.destroyed).toBe(true)
})

it('cancels a stalled read without retaining a usable partial revision', async () => {
  const source = new Readable({ read() {} }), controller = new AbortController()
  const pending = editContent(source, controller.signal, true)
  source.push(Buffer.from('partial'))
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(source.destroyed).toBe(true)
})

it('returns an immutable local payload and fails closed on read errors', async () => {
  const original = Buffer.from('revision')
  const result = await editContent(Readable.from([original]), new AbortController().signal, true)
  original.fill(0)
  expect(result.content.toString()).toBe('revision')
  const broken = new Readable({ read() { this.destroy(new Error('disconnected')) } })
  await expect(editContent(broken, new AbortController().signal)).rejects.toThrow('disconnected')
})
