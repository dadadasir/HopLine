# 发行版测试

`fixtures/` 是手写的合成输出，用于覆盖 BusyBox、GNU 工具及 systemd 环境的格式差异。主机名、资源数据、进程和端口均为示例。普通 `npm test` 使用其中的基础与状态数据，另可直接运行完整离线快照：

```sh
npx --no-install vitest run -c vitest.distro.config.ts tests/distro/collect-snapshot.test.ts tests/distro/security-snapshot.test.ts
```

此目录还保留了可选的本机容器测试工具。普通测试及离线快照不需要 Docker。容器工具不接收真实主机配置，通过 `127.0.0.1` 上的随机端口访问测试容器，并使用临时生成的 SSH 密钥和预设测试账号。systemd 靶机需要特权容器。此工具也可将本机容器输出采集到 `fixtures/`，如需实验，请在临时工作副本执行，以保留合成样本。

如需验证服务器兼容性，请使用专用且已授权的环境。
