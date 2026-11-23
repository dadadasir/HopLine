export type HostSecretField = 'password' | 'passphrase' | 'proxyPassword' |
  { jumpIndex: number; field: 'password' | 'passphrase' }

export const KEYSTORE_UNREADABLE = {
  zh: '无法读取系统钥匙串中的 Hopline 密钥。请完全退出 HopLine 后重新打开，在系统提示时输入开机密码并选择「始终允许」。已保存的数据没有丢失。',
  en: 'Unable to read the Hopline key in the system keychain. Quit HopLine completely and reopen it. When prompted, enter your computer login password and select “Always Allow”. Your saved data is intact.'
}

export function isKeystoreReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error
  return message === KEYSTORE_UNREADABLE.zh || message === KEYSTORE_UNREADABLE.en ||
    typeof message === 'string' && message.startsWith('Error while decrypting the ciphertext provided to safeStorage.decryptString')
}
