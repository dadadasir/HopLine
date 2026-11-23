import type { Locale } from '@shared/types'

export const whatsNew: Record<string, Record<Locale, string[]>> = {
  '0.2.0': {
    zh: ['使用 SSH agent 认证，无需重复输入密钥口令', '通过多级跳板连接主机', '从 ~/.ssh/config 导入主机', '管理本地、远程和动态端口转发', '保存和复用常用命令片段'],
    en: ['Authenticate with SSH agent without repeating key passphrases', 'Connect through multiple jump hosts', 'Import hosts from ~/.ssh/config', 'Manage local, remote and dynamic port forwarding', 'Save and reuse command snippets']
  },
  '0.3.0': {
    zh: ['持久会话：断网或重启后回到原来的终端，后台任务结束时提醒你', '总览集中展示主机状态和健康分', '安全体检提供风险证据和修复建议', '新机初始化提供命令预览与执行汇总', '磁盘清理帮助释放服务器空间'],
    en: ['Persistent sessions: return to the same terminal after a disconnect or restart, with alerts when background tasks finish', 'See host status and health scores in Overview', 'Run security checks with evidence and remediation suggestions', 'Initialize new servers with command previews and execution summaries', 'Free server space with disk cleanup']
  },
  '0.4.0': {
    zh: ['新的总览和主机工作区。可直接打开文件或复制连接信息，复制后 60 秒清除剪贴板', '磁盘清理先分析占用，再预览命令和预计可回收空间', '远程编辑在核验文件内容和属性后原子替换', '可更换主密码，可在设置中取消进行中的 WebDAV 备份传输', '窗口可见时自动采集前五台主机，首次连接后立即更新状态'],
    en: ['Use the new Overview and host workspace to browse files or copy connection information. Copied credentials clear after 60 seconds.', 'Analyze disk usage, then preview cleanup commands and estimated reclaimable space', 'Remote edits verify file contents and metadata before atomic replacement', 'Change your master password and cancel WebDAV backup transfers from Settings', 'Automatically collect the first five hosts while the window is visible and update status after your first connection.']
  }
}

export function releaseNotesBetween(previous: string, current: string, locale: Locale) {
  // Notes are stable releases; prereleases fall just before their matching release.
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(value)
  const compare = (left: string, right: string) => {
    const a = parse(left)!, b = parse(right)!
    for (let i = 1; i <= 3; i++) if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1
    return Number(!a[4]) - Number(!b[4])
  }
  if (!parse(previous) || !parse(current) || compare(current, previous) <= 0) return []
  return Object.keys(whatsNew).filter((version) => compare(version, previous) > 0 && compare(version, current) <= 0)
    .sort((a, b) => compare(b, a)).map((version) => ({ version, notes: whatsNew[version][locale] }))
}
