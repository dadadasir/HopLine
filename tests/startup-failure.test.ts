import { describe, expect, it } from 'vitest'
import { startupFailureMessage } from '../src/core/startup-failure'
import { migrateStore, NewerVersionError } from '../src/core/vault-migrate'

describe('startup failure messages without Electron', () => {
  it('returns a Chinese title and upgrade instructions with the path carried by the error', () => {
    const filePath = '/Users/test/主机库/hopline-store.json'
    const error = new NewerVersionError(filePath)
    const notice = startupFailureMessage(error)
    expect(error.filePath).toBe(filePath)
    expect(notice).toEqual({
      title: '无法打开主机库',
      message: `数据文件来自更新版本的 HopLine，当前版本无法打开。请安装最新版本后再试。\n\n数据文件未做任何修改：${filePath}`
    })
    expect(startupFailureMessage(error)).toEqual(notice)
    expect(error.filePath).toBe(filePath)
  })

  it.each([
    new Error('读取失败'),
    new Error('数据文件来自更新版本的 Hopline'),
    Object.assign(new Error('版本过新'), { name: 'NewerVersionError', filePath: '/not-a-version-error' }),
    { name: 'NewerVersionError', filePath: '/not-an-error' },
    null, undefined, '版本过新', 99
  ])('returns null for other errors or thrown values: %j', (error) => {
    expect(startupFailureMessage(error)).toBeNull()
  })

  it('preserves the source path supplied to the pure migration function', () => {
    const filePath = '/data/hopline-store.json'
    expect(() => migrateStore({ version: 99 }, 123, filePath))
      .toThrow(expect.objectContaining({ name: 'NewerVersionError', filePath }))
  })
})
