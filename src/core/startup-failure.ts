import { NewerVersionError } from './vault-migrate'

/** Describe only unsupported store versions; all other startup failures keep their existing behavior. */
export function startupFailureMessage(error: unknown): { title: string; message: string } | null {
  if (!(error instanceof NewerVersionError)) return null
  return {
    title: '无法打开主机库',
    message: `数据文件来自更新版本的 HopLine，当前版本无法打开。请安装最新版本后再试。\n\n数据文件未做任何修改：${error.filePath}`
  }
}
