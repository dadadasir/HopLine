const zh = {
  checkUpdates: '检查更新…',
  help: '帮助', diagnostics: '导出诊断包…', rendererCrashed: '界面连续崩溃，已停止自动重载。请重新打开 Hopline，并通过「帮助 › 导出诊断包」保存诊断信息。',
  about: '关于 Hopline', settings: '设置…', hide: '隐藏 Hopline', hideOthers: '隐藏其他', unhide: '显示全部',
  quitApp: '退出 Hopline', quit: '退出', file: '文件', newLocal: '新建本地终端', newHost: '新建主机',
  backup: '立即备份', closeTab: '关闭标签', edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切',
  copy: '复制', paste: '粘贴', selectAll: '全选', view: '查看', palette: '命令面板', find: '搜索',
  sidebar: '切换侧边栏', fullscreen: '切换全屏', reload: '重新加载', devTools: '切换开发者工具',
  window: '窗口', minimize: '最小化', zoom: '缩放', front: '全部置于顶层',
  localTitle: '本地终端', ptyUnavailable: '本地终端不可用：node-pty 没有按 Electron 重新编译'
}
const en: Record<keyof typeof zh, string> = {
  checkUpdates: 'Check for updates…',
  help: 'Help', diagnostics: 'Export diagnostics…', rendererCrashed: 'The interface has repeatedly crashed. Automatic reload has stopped. Reopen Hopline and use Help › Export diagnostics to save a report.',
  about: 'About Hopline', settings: 'Settings…', hide: 'Hide Hopline', hideOthers: 'Hide Others', unhide: 'Show All',
  quitApp: 'Quit Hopline', quit: 'Quit', file: 'File', newLocal: 'New Local Terminal', newHost: 'New Host',
  backup: 'Back up now', closeTab: 'Close Tab', edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut',
  copy: 'Copy', paste: 'Paste', selectAll: 'Select All', view: 'View', palette: 'Command Palette', find: 'Find',
  sidebar: 'Toggle Sidebar', fullscreen: 'Toggle Full Screen', reload: 'Reload', devTools: 'Toggle Developer Tools',
  window: 'Window', minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
  localTitle: 'Local terminal', ptyUnavailable: 'Local terminal unavailable: node-pty has not been rebuilt for Electron'
}

export function translate(locale: 'zh' | 'en', key: keyof typeof zh): string {
  return (locale === 'en' ? en : zh)[key]
}
