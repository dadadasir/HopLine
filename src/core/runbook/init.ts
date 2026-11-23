import type { Runbook, RunbookStep } from './types'
import { timezoneRunbook } from './samples'

const state = `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
b=/var/lib/hopline/init
install -d -m 700 "$b"`
const userCheck = `id "$HL_USER" >/dev/null 2>&1 && id -nG "$HL_USER" | tr ' ' '\\n' | grep -Eq '^(sudo|wheel)$'`
const keyHome = `home=$(getent passwd "$HL_USER" | cut -d: -f6)
[ -n "$home" ] || exit 10
key=$(printf '%s\\n' "$HL_PUBKEY" | awk '{print $1" "$2}')`
const keyMatch = `awk -v key="$key" '$1" "$2==key{found=1} END{exit !found}' "$home/.ssh/authorized_keys"`
const keyCheck = `${keyHome}
[ -r "$home/.ssh/authorized_keys" ] && ${keyMatch} &&
[ "$(stat -c '%a:%u:%g' "$home/.ssh")" = "700:$(id -u "$HL_USER"):$(id -g "$HL_USER")" ] &&
[ "$(stat -c '%a:%u:%g' "$home/.ssh/authorized_keys")" = "600:$(id -u "$HL_USER"):$(id -g "$HL_USER")" ]`
const sshReload = `if command -v systemctl >/dev/null 2>&1; then systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service
else rc-service sshd reload; fi`
function sshStep(id: string, option: string, extra = ''): RunbookStep {
  const setup = `${state}
main=/etc/ssh/sshd_config
fragment=/etc/ssh/sshd_config.d/10-hopline.conf
backup="$b/${id}"
restore() {
  cp -p "$backup.main" "$main" || return 1
  if [ -f "$backup.fragment" ]; then cp -p "$backup.fragment" "$fragment"
  elif [ -f "$backup.absent" ]; then rm -f "$fragment"; fi
}`
  const effective = `PATH=/usr/sbin:/usr/bin:/sbin:/bin
sshd -T 2>/dev/null | grep -qx '${option.toLowerCase()} no'`
  return { id, title: `init.${id}`, sudo: true, dangerous: true, gate: 'login-as-new-user',
    check: `${effective} && exit 0; exit 10`,
    apply: `${setup}
cp -p "$main" "$backup.main"
rm -f "$backup.fragment" "$backup.absent"
if [ -e "$fragment" ]; then cp -p "$fragment" "$backup.fragment"; else touch "$backup.absent"; fi
trap 'restore' EXIT
if sshd -T -f /dev/null -o 'Include /dev/null' >/dev/null 2>&1; then
  install -d -m 755 /etc/ssh/sshd_config.d
  { printf '%s\\n' '${option} no' ${extra}; [ ! -f "$backup.fragment" ] || cat "$backup.fragment"; } > "$fragment"
  { printf '%s\\n' 'Include /etc/ssh/sshd_config.d/10-hopline.conf'; cat "$backup.main"; } > "$main"
else
  { printf '%s\\n' '${option} no' ${extra}; cat "$backup.main"; } > "$main"
fi
# Never reload an invalid configuration; EXIT restores both files on failure.
sshd -t || exit 1
${sshReload}
trap - EXIT`,
    verify: effective,
    rollback: `${setup}
restore
sshd -t && { ${sshReload}; }`
  }
}
const ports = `PATH=/usr/sbin:/usr/bin:/sbin:/bin
ports=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}')
if [ -z "$ports" ]; then set -- \${SSH_CONNECTION:-}; ports=\${4:-}; fi
[ -n "$ports" ] || exit 1
for port in $ports; do case "$port" in ''|*[!0-9]*) exit 1;; esac; [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || exit 1; done`
const firewallCheck = `${ports}
if command -v ufw >/dev/null 2>&1; then
  ufw status | grep -q '^Status: active' || exit 10
  for port in $ports; do ufw status | grep -Eq "^$port/tcp[[:space:]].*ALLOW" || exit 10; done
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --state >/dev/null || exit 10
  for port in $ports; do firewall-cmd --query-port="$port/tcp" >/dev/null && firewall-cmd --permanent --query-port="$port/tcp" >/dev/null || exit 10; done
else exit 10; fi`
const swapCheck = `[ "$(wc -l < /proc/swaps)" -gt 1 ]`
const updatesCheck = `if command -v apt-get >/dev/null 2>&1; then
  dpkg-query -W -f='\${Status}' unattended-upgrades 2>/dev/null | grep -q 'install ok installed' &&
  grep -Eq 'APT::Periodic::Update-Package-Lists "1";' /etc/apt/apt.conf.d/20auto-upgrades &&
  grep -Eq 'APT::Periodic::Unattended-Upgrade "1";' /etc/apt/apt.conf.d/20auto-upgrades
elif command -v dnf >/dev/null 2>&1; then
  grep -Eq '^apply_updates[[:space:]]*=[[:space:]]*yes' /etc/dnf/automatic.conf && systemctl is-enabled --quiet dnf-automatic.timer && systemctl is-active --quiet dnf-automatic.timer
else exit 10; fi`
export const initRunbook: Runbook = {
  id: 'init', title: 'init.title',
  params: [
    { name: 'USER', label: 'init.user', pattern: '^(?!root$)[a-z_][a-z0-9_-]{0,31}$' },
    { name: 'PUBKEY', label: 'init.pubkey', pattern: '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\\.com) [A-Za-z0-9+/=]+( [^\\r\\n]{0,100})?$' },
    { name: 'USER_PASSWORD', label: 'init.password', pattern: '^[^\\r\\n\\0]{1,1024}$', secret: true },
    { name: 'SWAP_MB', label: 'init.swapSize', pattern: '^(|25[6-9]|2[6-9][0-9]|[3-9][0-9]{2}|[1-9][0-9]{3}|1[0-5][0-9]{3}|16[0-2][0-9]{2}|163[0-7][0-9]|1638[0-4])$' },
    ...timezoneRunbook.params!
  ],
  steps: [
    { id: 'create-user', title: 'init.create-user', sudo: true, stdin: 'USER_PASSWORD',
      check: `${userCheck} && exit 0; exit 10`,
      apply: `${state}
rm -f "$b/created-$HL_USER"
if ! id "$HL_USER" >/dev/null 2>&1; then useradd -m -s /bin/sh "$HL_USER"; touch "$b/created-$HL_USER"; fi
if getent group sudo >/dev/null; then group=sudo; else group=wheel; fi
usermod -aG "$group" "$HL_USER"
IFS= read -r user_password
printf '%s:%s\\n' "$HL_USER" "$user_password" | chpasswd`,
      verify: userCheck, rollback: `${state}
if [ -f "$b/created-$HL_USER" ]; then userdel -r "$HL_USER" && rm -f "$b/created-$HL_USER"; fi` },
    { id: 'deploy-key', title: 'init.deploy-key', sudo: true,
      check: `${keyCheck} && exit 0; exit 10`,
      apply: `${state}
${keyHome}
[ ! -L "$home/.ssh" ] && [ ! -L "$home/.ssh/authorized_keys" ] || exit 1
rm -f "$b/key-added-$HL_USER"
install -d -m 700 -o "$HL_USER" -g "$(id -gn "$HL_USER")" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
if ! ${keyMatch}; then
  printf '\\n%s\\n' "$HL_PUBKEY" >> "$home/.ssh/authorized_keys"
  touch "$b/key-added-$HL_USER"
fi
chmod 600 "$home/.ssh/authorized_keys"
chown "$HL_USER:$(id -gn "$HL_USER")" "$home/.ssh" "$home/.ssh/authorized_keys"`,
      verify: keyCheck,
      rollback: `${state}
${keyHome}
[ -f "$b/key-added-$HL_USER" ] || exit 0
awk -v key="$key" '$1" "$2!=key' "$home/.ssh/authorized_keys" > "$b/keys"
cat "$b/keys" > "$home/.ssh/authorized_keys"; rm -f "$b/keys"` },
    sshStep('ssh-disable-password', 'PasswordAuthentication', "'ChallengeResponseAuthentication no'"),
    sshStep('ssh-disable-root', 'PermitRootLogin'),
    { id: 'firewall', title: 'init.firewall', sudo: true, dangerous: true,
      check: `${firewallCheck}\nexit 0`,
      apply: `${ports}
set -e
if command -v ufw >/dev/null 2>&1; then
  for port in $ports; do ufw allow "$port/tcp"; done
  for port in $ports; do ufw show added | grep -F -- "allow $port/tcp" >/dev/null; done
  ufw --force enable
elif command -v firewall-offline-cmd >/dev/null 2>&1; then
  if firewall-cmd --state >/dev/null 2>&1; then
    for port in $ports; do firewall-cmd --permanent --add-port="$port/tcp"; firewall-cmd --add-port="$port/tcp"; firewall-cmd --query-port="$port/tcp"; done
  else
    for port in $ports; do firewall-offline-cmd --add-port="$port/tcp"; firewall-offline-cmd --query-port="$port/tcp"; done
  fi
  systemctl enable --now firewalld
else printf '%s\\n' 'init.noFirewall'; exit 30; fi`,
      verify: firewallCheck,
      rollback: 'if command -v ufw >/dev/null 2>&1; then ufw disable; else systemctl disable --now firewalld; fi' },
    { id: 'swap', title: 'init.swap', sudo: true, check: `${swapCheck} && exit 0; exit 10`,
      apply: `${state}
[ -n "$HL_SWAP_MB" ] || { printf '%s\\n' 'init.noSwapSize'; exit 30; }
[ ! -e /swapfile ] && [ ! -L /swapfile ] || exit 1
cp -p /etc/fstab "$b/fstab"
trap 'swapoff /swapfile 2>/dev/null || :; rm -f /swapfile; cp -p "$b/fstab" /etc/fstab' EXIT
(umask 077; set -C; : > /swapfile)
chmod 600 /swapfile
fallocate -l "\${HL_SWAP_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$HL_SWAP_MB"
mkswap /swapfile
swapon /swapfile
printf '%s\\n' '/swapfile none swap sw 0 0' >> /etc/fstab
trap - EXIT`,
      verify: swapCheck, rollback: `${state}
swapoff /swapfile && rm -f /swapfile && cp -p "$b/fstab" /etc/fstab` },
    { id: 'docker', title: 'init.docker', sudo: true, check: 'command -v docker >/dev/null && exit 0; exit 10',
      apply: `set -e
if command -v apt-get >/dev/null 2>&1; then apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
elif command -v dnf >/dev/null 2>&1; then dnf install -y docker || dnf install -y moby-engine
elif command -v apk >/dev/null 2>&1; then apk add docker
else exit 30; fi
if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker
else rc-update add docker default; rc-service docker start; fi`, verify: 'command -v docker >/dev/null' },
    timezoneRunbook.steps[0],
    { id: 'auto-updates', title: 'init.auto-updates', sudo: true, check: `${updatesCheck} && exit 0; exit 10`,
      apply: `set -e
if command -v apt-get >/dev/null 2>&1; then
  apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades
  printf '%s\\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y dnf-automatic
  sed -i 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' /etc/dnf/automatic.conf
  sed -i 's/^upgrade_type[[:space:]]*=.*/upgrade_type = security/' /etc/dnf/automatic.conf
  systemctl enable --now dnf-automatic.timer
else exit 30; fi`, verify: updatesCheck,
      rollback: `if command -v apt-get >/dev/null 2>&1; then printf '%s\\n' 'APT::Periodic::Unattended-Upgrade "0";' > /etc/apt/apt.conf.d/20auto-upgrades
else systemctl disable --now dnf-automatic.timer; fi` }
  ]
}
