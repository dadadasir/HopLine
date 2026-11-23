import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { Vault } from '../core/vault'
import { readStoreFile } from '../core/store-file'
import { writeJsonFile } from '../core/json-file'
import { createSafeCodec, KeystoreReadError } from './secrets'
import { logError } from './logger'

export interface OpenedVault {
  vault: Vault
  save: () => void
  filePath: string
  keystoreReadFailed: boolean
}

export function openVault(): OpenedVault {
  const filePath = path.join(app.getPath('userData'), 'hopline-store.json')
  const { data, hadRejectedRecords, migratedFrom } = readStoreFile(filePath, logError)
  if (migratedFrom !== null) {
    // COPYFILE_EXCL preserves earlier migration backups and fails closed on all other errors.
    try {
      fs.copyFileSync(filePath, `${filePath}.v${migratedFrom}.bak`, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('无法备份迁移前的数据文件，已停止读取', { cause: error })
      }
    }
  }
  const codec = createSafeCodec(() => vault.settingsPublic(false).language)
  const vault: Vault = new Vault(data, codec)
  const sample = vault.firstKeystoreSecret()
  let keystoreReadFailed = false
  if (sample) {
    try {
      codec.decrypt(sample)
    } catch (error) {
      if (!(error instanceof KeystoreReadError)) throw error
      keystoreReadFailed = true
    }
  }
  const save = () => writeJsonFile(filePath, vault.snapshot())
  if (hadRejectedRecords && !keystoreReadFailed) save()
  return { vault, save, filePath, keystoreReadFailed }
}
