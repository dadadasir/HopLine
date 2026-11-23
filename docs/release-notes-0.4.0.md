# HopLine 0.4.0

HopLine 是本地优先的 VPS 管家，通过 SSH 管理服务器，无需安装远端 agent。

## 主要功能

- 多标签 SSH、本地终端、SFTP、远程编辑、跳板机、代理、端口转发和 SSH 配置导入。
- 主机总览、健康分、安全体检与先预览再执行的维护流程。窗口可见时自动采集前五台主机，总览每分钟刷新，其他页面默认每五分钟刷新。可在外观设置里调整间隔或关闭自动采集。所有主机均可在详情页手动刷新。
- 月／年费用总览，人民币／美元双币显示，欧洲央行参考汇率及本地缓存；续费与证书提醒统一为 15 天，周期续费日期自动顺延显示。
- 主机详情可复制 SSH 命令和连接信息。连接信息含备注与已保存的密码，私钥与口令留在本机。连接编辑框提供受保护的密码与口令显示和复制。侧栏多选按可见顺序逐行复制 SSH 命令，支持粘贴 SSH 命令和识别开通文本。
- 本地加密备份、WebDAV 手动快照、菜单栏摘要与双语界面。

## 安装与升级

0.4.0 的 macOS 安装包已使用 Developer ID 签名并经 Apple 公证。

1. 下载 Apple Silicon（arm64）ZIP 和 `SHA256SUMS.txt`。
2. 校验 ZIP 的 SHA-256 后解压。
3. 将 HopLine 拖入「应用程序」，然后打开。

从 0.3.x 升级后首次打开 HopLine 时，macOS 可能请求访问钥匙串。请在系统提示时输入开机密码并选择「始终允许」。钥匙串读取失败时，总览会提供「退出并重新打开」。

## 已知限制与反馈

- 0.4.0 仅提供 Apple Silicon Mac 安装包。
- 退出应用后停止采集。
- 暂不支持多设备同步。
- 问题反馈和功能建议只通过 [Issues](https://github.com/dadadasir/HopLine/issues) 接受。

## SHA-256 校验

将 ZIP 和 `SHA256SUMS.txt` 下载到同一目录，在终端运行：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

应显示对应 ZIP 为 `OK`。如只下载部分文件，请从清单中选择对应行校验；不一致时不要打开安装包。

---

HopLine is a local-first VPS manager that connects over SSH without installing a server agent.

## Highlights

- SSH tabs, local terminals, SFTP, remote editing, jump hosts, proxies, port forwarding and SSH configuration import.
- Host overview, health scores, security checks and maintenance with command previews. While the window is visible, HopLine collects the first five hosts every minute in Overview and every five minutes elsewhere by default. Adjust or disable automatic collection in Appearance settings. Refresh any host from its details.
- Monthly/yearly billing, CNY/USD display, ECB reference rates with local caching, 15-day renewal/certificate notices and derived recurring renewal dates.
- Copy SSH commands and connection information from the host heading. The connection card includes the note and any saved password. Private keys and passphrases stay local. Reveal or copy protected passwords and passphrases in the connection editor. Copy one SSH command per selected host in visible sidebar order. SSH paste and provisioning-text recognition are supported.
- Encrypted local backups, manual WebDAV snapshots, menu-bar summaries and Chinese/English interfaces.

## Install and upgrade

The 0.4.0 macOS package is signed with Developer ID and notarized by Apple.

1. Download the Apple Silicon (arm64) ZIP and `SHA256SUMS.txt`.
2. Verify the ZIP’s SHA-256 checksum and extract it.
3. Drag HopLine into **Applications**, then open it.

The first time you open HopLine after upgrading from 0.3.x, macOS may request access to Keychain. When prompted, enter your Mac login password and choose **Always Allow**. If HopLine cannot read Keychain, Overview offers **Quit and reopen**.

## Known limits and feedback

- The 0.4.0 installer is available for Apple Silicon Macs only.
- Data collection stops when you quit HopLine.
- Multi-device sync is unavailable.
- Bug reports and feature suggestions are accepted through [Issues](https://github.com/dadadasir/HopLine/issues) only.

## Verify SHA-256

Download the ZIP and `SHA256SUMS.txt` into one directory, then run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

The ZIP should report `OK`. If you downloaded only some assets, check the matching lines from the manifest. Do not open a package whose checksum differs.
