#!/bin/sh
set -eu
: "${HOPLINE_PUBLIC_KEY:?缺少测试公钥}"
: "${HOPLINE_TEST_PASSWORD:?缺少测试密码}"
for user in root admin ops; do
  if [ "$user" = root ]; then home=/root; else home=/home/$user; fi
  mkdir -p "$home/.ssh"
  printf '%s\n' "$HOPLINE_PUBLIC_KEY" > "$home/.ssh/authorized_keys"
  chmod 700 "$home/.ssh"
  chmod 600 "$home/.ssh/authorized_keys"
  chown -R "$user:$(id -gn "$user")" "$home/.ssh"
  printf '%s:%s\n' "$user" "$HOPLINE_TEST_PASSWORD" | chpasswd
done
unset HOPLINE_PUBLIC_KEY HOPLINE_TEST_PASSWORD
mkdir -p /run/sshd
ssh-keygen -A
exec "$@"
