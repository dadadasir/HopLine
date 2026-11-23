# Changelog

Notable user-facing changes are recorded here, using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories.

## [0.4.0] - 2026-11-19

首次公开发布仅提供 **macOS Apple Silicon（arm64）ZIP 安装包**。安装包已使用 Developer ID 签名并经 Apple 公证。下载 ZIP，按[发行说明](docs/release-notes-0.4.0.md#sha-256-校验)校验 SHA-256，解压后将 HopLine 拖入「应用程序」并打开。

从 0.3.x 升级后首次打开 HopLine 时，macOS 可能请求访问钥匙串。请在系统提示时输入开机密码并选择「始终允许」。钥匙串读取失败时，总览会提供「退出并重新打开」。

### 新增与调整

- 主机详情标题区可复制 SSH 命令和连接信息。连接信息包含备注和已保存的密码，不含私钥与口令。连接编辑框可受保护地显示和复制已保存的密码与口令。侧栏多选按可见顺序逐行复制 SSH 命令。支持粘贴 SSH 命令和识别开通文本，新主机和跳板机默认用户名为 root。
- 开源版新增覆盖全部主机的计费总览，从「每月费用」卡片进入，提供六列表格、月／年合计与返回总览入口，卡片外观与其他卡片一致。
- 主要币种只提供跟随语言、人民币、美元；总览与资产页简洁显示双币金额。汇率采用内置欧洲央行参考值或本地缓存，启动 30 秒后及每 24 小时静默检查，使用系统代理，有主机填写价格时请求（含主次币种互换）。
- 公共续费及证书提醒窗口统一为 15 天，7 天内加重扣分不变。周期续费过期后自动推算显示，续费当天显示「今天续费」，一次性及未填周期的过期日期仍显示逾期；界面日期统一为 YYYY-MM-DD。

- 重做总览、主机工作区、任务活动、设置和帮助导航。无需打开终端即可浏览服务器文件，切换页面后保留文件路径和设置草稿。
- 磁盘清理先分析空间，再预览命令和预计可回收量。支持更多清理项目、按日志驱动处理容器日志，并报告实际空间变化。
- SSH 支持 SOCKS5 和 HTTP CONNECT 代理。安全体检用可读证据说明风险，分享卡默认隐藏主机信息。
- 新增菜单栏状态、GitHub 更新检查，以及首次连接后查看和刷新主机状态的引导。
- 新建主机可留空名称并直接保存连接，首次连接后自动读取状态，再选择运行安全体检或跳过。
- 窗口可见时，按列表顺序自动采集前五台主机。总览每分钟更新，其他页面默认每五分钟更新，可在外观设置中关闭或调整。需要认证时显示「连接并确认」，连接失败后延迟重试。所有主机仍可从详情页手动刷新。
- 减少启动时加载的界面，首次打开终端时按需加载终端组件。新增 HopLine 应用图标。

### 修复

- 编辑框有未保存的密码或口令时暂时禁用复制。操作提示显示在右下角，避开标题区按钮。
- 系统钥匙串读取失败时保留已保存的凭据。受影响的操作显示统一提示。

- 关闭凭据身份验证先授权，导入备份不降低本机验证要求。退出时在一秒内尽力清理仍归属本应用的密码剪贴板；超时继续退出。
- 修正多选菜单及可见顺序复制、SSH 参数和地址识别；忽略 URL 内的面板地址与端口。

- 只有价格、币种或周期发生修改时才校验配套字段，旧主机改名、修改连接和初始化保存不受缺失资产信息影响；计费页提示信息不完整并可跳转补充。
- 周期续费显示自动顺延至不早于今天的一期，保留最初日号，月底收敛后仍可恢复 31 日；保存资产表单时才写回。
- RMB 规范为 CNY，金额按币种默认小数位显示；未覆盖币种保留原币种月费并排除合计。

- 远程编辑先在同一目录完整写入并核验临时文件，再原子替换。文件属性无法安全保留时停止保存，保留本地编辑副本供恢复。
- 可在设置中更换主密码。改进加密备份、解锁和导入发生写盘失败时的回滚，修复旧备份恢复已删除分组的问题。
- WebDAV 上传和下载支持取消与超时，并限制目录列表和备份大小。设置中可查看备份范围。
- 状态过期、权限不足或采集失败时，显示待确认和具体原因。兼容旧 yum 系统的只读安全更新查询。
- 改进连接确认、错误恢复和清理取消反馈。输入提交失败后可继续使用键盘重试。

### Release scope

The first public release provides a **macOS Apple Silicon (arm64) ZIP package only**. The package is signed with Developer ID and notarized by Apple. Download the ZIP, [verify its SHA-256 checksum](docs/release-notes-0.4.0.md#verify-sha-256), extract it, then drag HopLine into **Applications** and open it.

The first time you open HopLine after upgrading from 0.3.x, macOS may request access to Keychain. When prompted, enter your Mac login password and choose **Always Allow**. If HopLine cannot read Keychain, Overview offers **Quit and reopen**.

### Added and changed

- The host heading copies SSH commands and connection information, including the note and any saved password. The connection card excludes private keys and passphrases. The connection editor offers protected controls to reveal and copy saved passwords and passphrases. Sidebar multi-selection copies SSH commands in visible order. SSH paste and provisioning-text recognition are supported. New hosts and jump hosts default to root.
- Added community billing for all hosts, opened from the monthly cost card, styled like the other cards. The page has six columns, monthly/yearly estimates and a back button.
- Display currency offers follow-language, CNY and USD, with simple dual-currency amounts. Bundled ECB reference rates or cached rates are used; silent checks start after 30 seconds and repeat every 24 hours, using system proxies and only when a host has a price, including main/secondary currency conversion.
- Unified public renewal and certificate notices at 15 days, retaining heavier seven-day deductions. Recurring overdue dates are derived forward; renewal day reads “Renews today”. One-time or unspecified cycles retain overdue dates. Interface dates use YYYY-MM-DD.

- Redesigned Overview, host workspaces, activity, settings and help navigation. Browse server files without opening a terminal; file paths and settings drafts survive page changes.
- Analyze disk usage before previewing cleanup commands and estimated reclaimed space. More cleanup targets, log-driver-aware container cleanup and actual space-change reports are supported.
- SSH supports SOCKS5 and HTTP CONNECT proxies. Security checks explain risks with readable evidence; shared score cards hide host details by default.
- Added menu-bar status, GitHub update checks and guidance to view and refresh host status after the first connection.
- Leave the name blank to use the host address, or select **Save and connect** to open the connection immediately. HopLine collects status after the first connection and offers a security check.
- While the window is visible, HopLine collects the first five hosts in list order. It checks every minute in Overview and every five minutes elsewhere by default. Change or disable automatic collection in Appearance settings. Hosts needing authentication offer **Connect and confirm**, and failed connections retry with increasing delays. All hosts support manual refresh.
- Reduced startup loading and load terminal components when first needed. Added the HopLine app icon.

### Fixed

- Copy is disabled while the editor contains a changed, unsaved password or passphrase. Notifications appear at the bottom right, clear of the header controls.
- Keep saved credentials intact when Keychain cannot be read and show a consistent message in affected actions.

- Disabling credential verification requires authorization; backup imports cannot lower local verification. Quitting attempts to clear the owned secret clipboard within one second, then continues even if cleanup times out.
- Corrected multi-selection menus, visible-order copying, SSH options and address recognition; panel addresses and ports inside URLs are ignored.

- Only actual price/currency/cycle edits require complete billing details, preserving rename, connection and initialization saves for legacy hosts. Incomplete billing rows link to asset details.
- Recurring overdue renewal dates are derived through today, retaining the original day so month-end clamping does not lose the 31st. Saving the asset form writes the derived date.
- RMB becomes CNY and display uses currency-specific precision. Unsupported currencies retain their original monthly amount and are excluded from totals.

- Remote edits stage and verify a complete file in the same directory before atomic replacement. Saving stops when metadata cannot be preserved safely, keeping a local recovery copy.
- Change the master password in Settings. Improved rollback after encrypted-backup, unlock and import write failures, and fixed deleted groups being restored from old backups.
- WebDAV uploads and downloads support cancellation, timeouts, directory-listing and backup-size limits. Settings describe the backup scope.
- Stale status, missing permissions and failed collection show an unconfirmed state and a specific reason. Read-only security-update queries support older yum systems.
- Improved connection confirmation, error recovery and cleanup cancellation feedback. Keyboard submission can be retried after failure.

## [0.3.0] - 2026-10-27

### Added

- Optional HopLine shell integration for bash and zsh, installed and removed from the host menu: the SFTP panel can follow the terminal's directory, and ordinary sessions can jump between commands, copy the last command's output, and mark failed commands.
- Persistent sessions (tmux) with automatic reattach, background-tab desktop notifications (BEL, OSC 9, OSC 777), OSC 9;4 progress and AI agent detection.
- SSH-based server inspection with complete, partial, or unavailable results and reasons for missing data.
- Overview cards with health scores, server details, editable asset information, monthly cost totals by currency, and upcoming renewal dates.
- Security checks with scores, supporting evidence, copyable remediation commands, per-host ignored findings, and shareable score cards.
- Previewed maintenance workflows with checks, verification, supported rollback steps, and local operation history.
- A selectable new-server initialization wizard with safety gates for SSH access and firewall changes.
- Disk analysis and manual cleanup with estimated reclaimable space, command previews, and per-step results.
- Local diagnostic export with a redaction preview, rotating logs, and records of UI stalls; limited automatic reload attempts after renderer crashes.
- Dismissible first-run guidance, clearer overview empty states, and a one-time upgrade notice with release highlights.
- Development packages through GitHub Actions for macOS arm64/x64 and Linux x64 AppImage/deb. macOS packages remain unsigned and not notarized.

### Changed

- Security check evidence is shown as plain-language descriptions in both languages, with the raw data still available; the default SSH port is listed as a hint rather than an issue.
- Redesigned share card; the upgrade notice lists highlights from every version since the last one you used; overview cards show why a metric is unavailable.

### Fixed

- Certificate health reporting distinguishes expired and soon-to-expire certificates and avoids treating unreferenced certificates as active site certificates.

## [0.2.0]

### Added

- ssh-agent authentication, including 1Password and Secretive sockets, and optional agent forwarding.
- Multi-hop SSH connections and previewed `ssh_config` import with `Include`, `ProxyJump`, and agent settings.
- Local, remote, and dynamic SOCKS port forwarding, including automatic start on connection and forwarding that survives terminal-tab closure.
- Global and per-host command snippets with variable placeholders that insert without executing.
- Master-password encryption for saved credentials when the OS keystore is unavailable.
- Optional restoration of terminal tab layout and hosts after restart, without restoring screen contents.

### Changed

- Explicitly selected private keys are used without trying unrelated agent identities.
- Terminal contrast and handling of remote escape sequences improved: remote clipboard writes are blocked, notifications are rate-limited, and links require a click.
- Application menus and new local-terminal titles follow the selected interface language.

### Fixed

- Port-forwarded connections continue receiving responses after the client closes its sending side.
- Cancelling a resumable SFTP download preserves received data and reports cancellation consistently.
- Expired authentication prompts are dismissed, and recovered-edit notices no longer cover the bottom of the terminal.

## [0.1.1]

### Fixed

- SFTP uploads and downloads use temporary partial files for resume, avoiding corruption when same-name files differ.
- Remote edits refresh from the server, detect conflicting changes, and preserve unsent edits for recovery with visible notices.
- Invalid backup key-derivation parameters are rejected before expensive work; damaged local data files are preserved instead of silently overwritten.
- WebDAV backup selection and remote-directory creation are more reliable; backup names avoid collisions.
- Concurrent host-key and authentication prompts are queued, and the command palette supports keyboard navigation.
- Immediate backup gives useful feedback when locked, and reconnect uses the terminal's current size.
- Reopening the macOS window no longer duplicates application services. Shutdown waits for session cleanup, startup recovery failures are surfaced, and failed tab closure leaves the tab available for retry.
