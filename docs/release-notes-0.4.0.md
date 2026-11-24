# HopLine 0.4.0

HopLine 是给独立开发者的 VPS 管家：连上 SSH 就能看清每台机器的健康、问题和续费，服务器上不用装任何东西。这是首个公开版本。

## 主要功能

- **总览**：几台正常、哪台要处理、每月花多少、谁快到期，一页看清。窗口开着时自动采集前 5 台主机。
- **费用与续费**：记录价格和续费日期，人民币、美元双币汇总，到期前 15 天提醒。
- **安全与维护**：安全体检、新机初始化、磁盘分析与清理，操作前都先预览命令。
- **连接与终端**：多标签 SSH 终端、SFTP 文件、远程编辑，支持跳板机、代理和 `~/.ssh/config` 导入。
- **数据留在本机**：密码交给系统钥匙串，支持本地加密备份和 WebDAV。

## 安装

1. 下载下方的 `Hopline-0.4.0-community-mac-arm64.zip`（Apple Silicon Mac）。
2. 解压，把 HopLine 拖进「应用程序」，然后打开。

安装包已签名并经过 Apple 公证。首次打开时 macOS 可能请求访问钥匙串，输入开机密码并选择「始终允许」即可。

想校验下载文件的话，把 ZIP 和 `SHA256SUMS.txt` 放在同一目录，运行 `shasum -a 256 -c SHA256SUMS.txt`，应显示 `OK`。

## 下一版本预告

计划适配 AI 编程工具（MCP），让 Codex、Claude Code、Cursor 等工具能直接连上 HopLine 里的主机。

问题和建议欢迎提交到 [Issues](https://github.com/dadadasir/HopLine/issues)。

---

HopLine is a VPS manager for indie developers. Connect over SSH to see the health, issues, and renewals of every server, with nothing installed on your servers. This is the first public release.

## Highlights

- **Overview**: See which servers are fine, which need attention, what you spend each month, and what renews soon. The first 5 hosts are collected automatically while the window is open.
- **Costs and renewals**: Track prices and renewal dates, with CNY/USD totals and reminders 15 days ahead.
- **Security and maintenance**: Security checks, new-server setup, and disk cleanup, all with command previews before anything runs.
- **Connections and terminal**: Tabbed SSH terminals, SFTP, remote editing, jump hosts, proxies, and `~/.ssh/config` import.
- **Your data stays local**: Passwords go into the system keychain, with encrypted local backups and optional WebDAV.

## Install

1. Download `Hopline-0.4.0-community-mac-arm64.zip` below (Apple Silicon Macs).
2. Unzip it, drag HopLine into **Applications**, and open it.

The app is signed and notarized by Apple. On first launch, macOS may ask for Keychain access; enter your Mac login password and choose **Always Allow**.

To verify the download, put the ZIP and `SHA256SUMS.txt` in the same folder and run `shasum -a 256 -c SHA256SUMS.txt`. It should report `OK`.

## Coming next

The next version plans to support AI coding tools (MCP), so tools like Codex, Claude Code, and Cursor can connect to the hosts you manage in HopLine.

Bug reports and suggestions are welcome in [Issues](https://github.com/dadadasir/HopLine/issues).
