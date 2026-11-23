#!/bin/sh
set -eu

if command -v adduser >/dev/null 2>&1 && [ -f /etc/alpine-release ]; then
  adduser -D -s /bin/sh admin
  adduser -D -s /bin/sh ops
else
  useradd -m -s /bin/sh admin
  useradd -m -s /bin/sh ops
fi
mkdir -p /etc/sudoers.d /run/sshd
printf '%s\n' 'Defaults timestamp_timeout=0' 'admin ALL=(ALL) ALL' 'ops ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/hopline
chmod 440 /etc/sudoers.d/hopline
visudo -cf /etc/sudoers
# 包安装时可能生成主机密钥，镜像不保留任何密钥。
rm -f /etc/ssh/ssh_host_*
