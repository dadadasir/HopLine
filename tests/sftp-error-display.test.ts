import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { SftpPanel } from '../src/renderer/src/components/SftpPanel'
import { ActivityCenter } from '../src/renderer/src/components/ActivityCenter'
import { errorText, getState, patch } from '../src/renderer/src/state/store'
import { transferErrorText } from '../src/renderer/src/logic/transfer-error'
import type { TransferJob } from '../src/shared/types'
import { isKeystoreReadError, KEYSTORE_UNREADABLE } from '../src/shared/host-secrets'

vi.mock('../src/renderer/src/logic/shell-integration', () => ({ useShellIntegration: () => ({ active: false, cwd: undefined }) }))
const initial = getState()
const settings = new Vault(emptyStore(), new MemorySecretCodec()).settingsPublic(false)
afterEach(() => { patch(() => initial); vi.unstubAllGlobals() })
const failure = '下载路径包含软链接，请选择其他位置'
const english = 'The download path contains a symbolic link; choose another location'
const wrapped = `Error invoking remote method 'sftp:download': Error: ${failure}`

it('normalizes Electron wrappers without translating or removing useful backend details', () => {
  expect(errorText(new Error(wrapped))).toBe(failure)
  expect(errorText(wrapped)).toBe(failure)
  expect(errorText(new Error("Error invoking remote method 'sftp:cancel': AbortError: 已取消"))).toBe('已取消')
  expect(errorText(new Error('Permission denied: /remote/file'))).toBe('Permission denied: /remote/file')
  expect(errorText('server text: Error: detailed message')).toBe('server text: Error: detailed message')
})

it('uses the current language for a transfer failure after the user changes language', () => {
  patch({ settings: { ...settings, language: 'zh' } })
  expect(transferErrorText(new Error(wrapped))).toBe(failure)
  patch({ settings: { ...settings, language: 'en' } })
  expect(transferErrorText(new Error(wrapped))).toBe(english)
  expect(transferErrorText('custom server failure')).toBe('custom server failure')
})

it('recognizes the Electron keychain error prefix even with a diagnostic suffix', () => {
  const prefix = 'Error while decrypting the ciphertext provided to safeStorage.decryptString'
  const withSuffix = prefix + '. Decryption is not available.'
  expect(isKeystoreReadError(prefix)).toBe(true)
  expect(isKeystoreReadError(new Error(withSuffix))).toBe(true)
  expect(isKeystoreReadError(`Other error: ${withSuffix}`)).toBe(false)
  expect(isKeystoreReadError('Decryption is not available.')).toBe(false)
  patch({ settings: { ...settings, language: 'zh' } })
  expect(transferErrorText(new Error(withSuffix))).toBe(KEYSTORE_UNREADABLE.zh)
  patch({ settings: { ...settings, language: 'en' } })
  expect(transferErrorText(withSuffix)).toBe(KEYSTORE_UNREADABLE.en)
})

it.each(['sftp', 'activity'] as const)('renders %s queue failures in both languages without changing the stored job', (screen) => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  const job: TransferJob = { id: 'failed', sessionId: 'session', direction: 'download', name: 'file.txt',
    localPath: '/chosen/file.txt', remotePath: '/file.txt', loaded: 0, total: 10, status: 'error', error: wrapped }
  patch({ settings: { ...settings, language: 'en' }, hosts: [], tabs: [], forwards: [], transfers: { session: [job] } })
  const render = () => renderToStaticMarkup(screen === 'sftp' ? createElement(SftpPanel, { sessionId: 'session' }) : createElement(ActivityCenter))
  const englishHtml = render()
  expect(englishHtml).toContain(english)
  expect(englishHtml).not.toContain(failure)
  expect(englishHtml).not.toContain('Error invoking remote method')
  patch({ settings: { ...settings, language: 'zh' } })
  expect(render()).toContain(failure)
  expect(getState().transfers.session![0]).toBe(job)
  expect(job.error).toBe(wrapped)
})
