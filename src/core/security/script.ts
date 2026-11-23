import { CERT_SCRIPT } from './certs'
import { shellEscape } from '../shell'

const script = String.raw`#!/bin/sh
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
unavailable() { printf '#HOPLINE-UNAVAILABLE %s %s\n' "$1" "$2"; }
run() { "$@" 2>/dev/null || unavailable error "$1 failed (permissions or command unavailable)"; }
section() { printf '===HOPLINE:%s===\n' "$1"; "collect_$1"; printf '\n#HOPLINE-END\n'; }
bounded() { command -v timeout >/dev/null 2>&1 || return 127; timeout "$@"; }
collect_os() { run cat /etc/os-release; run uname -srm; }
collect_sshd() {
  effective=$(sshd -T 2>/dev/null)
  if [ $? -eq 0 ]; then printf '#HOPLINE-SOURCE effective\n%s\n' "$effective"
  else
    printf '#HOPLINE-PARTIAL sshd_config is not effective configuration; Include/Match may change values\n'
    cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || unavailable permission-denied sshd_config
  fi
}
collect_firewall() {
  seen=0; ok=0; failed=
  for tool in ufw firewall-cmd nft iptables; do
    command -v "$tool" >/dev/null 2>&1 || continue
    seen=1
    case "$tool" in ufw) out=$(ufw status 2>/dev/null);; firewall-cmd) out=$(firewall-cmd --state 2>/dev/null);; nft) out=$(nft list ruleset 2>/dev/null);; iptables) out=$(iptables -S 2>/dev/null);; esac
    code=$?
    # firewall-cmd exits 252 when firewalld is installed but stopped: that is an answer, not a failure.
    if [ "$tool" = firewall-cmd ] && [ "$code" -eq 252 ]; then out='not running'; code=0; fi
    if [ "$code" -eq 0 ]; then printf '#HOPLINE-SOURCE %s\n%s\n' "$tool" "$out"; ok=1; else failed="$failed $tool"; fi
  done
  [ "$seen" -eq 1 ] || printf '#HOPLINE-SOURCE none\n'
  # One unreadable tool must not hide the rules another tool did read.
  if [ -n "$failed" ]; then
    if [ "$ok" -eq 1 ]; then printf '#HOPLINE-PARTIAL could not read:%s\n' "$failed"
    elif [ "$(id -u)" -ne 0 ]; then unavailable permission-denied "firewall:$failed"
    else unavailable error "firewall:$failed"; fi
  fi
}
collect_listeners() {
  if command -v ss >/dev/null 2>&1; then run ss -Htlnp
  elif command -v netstat >/dev/null 2>&1; then run netstat -tlnp
  else unavailable not-installed 'ss and netstat'; fi
}
collect_yum_auto() {
  # yum-cron is an active/exited oneshot; crond is the process that schedules it.
  command -v systemctl >/dev/null 2>&1 || { printf '#HOPLINE-PARTIAL 无法读取 yum-cron 服务状态\n'; return; }
  for unit in yum-cron.service crond.service; do
    state=$(bounded -s KILL 3 systemctl show "$unit" -p LoadState -p UnitFileState -p ActiveState 2>/dev/null) || { printf '#HOPLINE-PARTIAL 无法读取 yum-cron 或 crond 服务状态\n'; return; }
    if printf '%s\n' "$state" | grep -Eq '^LoadState=not-found$|^UnitFileState=(disabled|masked|masked-runtime)$|^ActiveState=(inactive|failed)$'; then echo auto=no; return; fi
    if ! printf '%s\n' "$state" | grep -qx 'LoadState=loaded' || ! printf '%s\n' "$state" | grep -qx 'UnitFileState=enabled' || ! printf '%s\n' "$state" | grep -qx 'ActiveState=active'; then
      printf '#HOPLINE-PARTIAL yum-cron 或 crond 的启用状态未确认\n'; return
    fi
  done
  unknown=0; enabled=0
  for file in /etc/yum/yum-cron.conf /etc/yum/yum-cron-hourly.conf; do
    # The hourly configuration is optional; a missing daily configuration is unknown.
    if [ ! -e "$file" ] && [ "$file" = /etc/yum/yum-cron-hourly.conf ]; then continue; fi
    if [ ! -r "$file" ]; then unknown=1; continue; fi
    setting=$(awk '
      function boolean(value) { if (value ~ /^(yes|true|1|on)$/) return 1; if (value ~ /^(no|false|0|off)$/) return 0; return -1 }
      BEGIN { apply=0; download=0; commands=0; invalid=0 }
      /^[[:space:]]*[#;]/ { next }
      /^[[:space:]]*include[[:space:]]*=/ { invalid=1; next }
      /^[[:space:]]*\[/ { line=$0; sub(/^[[:space:]]*/, "", line); sub(/[[:space:]]*$/, "", line); inside=(line=="[commands]"); if (inside) commands=1; next }
      inside && /^[[:space:]]*(apply_updates|download_updates)[[:space:]]*=/ {
        key=$0; sub(/=.*/, "", key); gsub(/[[:space:]]/, "", key)
        value=$0; sub(/^[^=]*=/, "", value); sub(/[[:space:]]+;.*/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); value=tolower(value)
        if (key=="apply_updates") apply=boolean(value); else download=boolean(value)
        next
      }
      inside && $0 !~ /^[[:space:]]*$/ && $0 !~ /^[[:space:]]*[^:=]+[:=]/ { invalid=1 }
      END { if (invalid || !commands || apply<0 || download<0) print "unknown"; else if (apply && download) print "yes"; else print "no" }
    ' "$file") || setting=unknown
    case "$setting" in yes) enabled=1;; no) :;; *) unknown=1;; esac
  done
  if [ "$enabled" -eq 1 ]; then echo auto=yes
  elif [ "$unknown" -eq 0 ]; then echo auto=no
  else printf '#HOPLINE-PARTIAL yum-cron 配置不可读或包含未解析的配置\n'; fi
}
collect_updates() {
  if command -v apt-get >/dev/null 2>&1; then
    auto=$(apt-config dump 2>/dev/null)
    if [ $? -eq 0 ]; then
      if printf '%s\n' "$auto" | grep -Eq 'APT::Periodic::Unattended-Upgrade "[1-9][0-9]*"' && command -v unattended-upgrade >/dev/null 2>&1; then echo auto=yes; else echo auto=no; fi
    fi
    printf '#HOPLINE-SOURCE apt\n'; bounded 20 apt-get -s upgrade 2>/dev/null && echo pending-complete=yes || printf '#HOPLINE-PARTIAL security update query unavailable (20s limit; timeout utility or cached metadata may be missing)\n'
  elif command -v dnf >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      if systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1 && systemctl is-active dnf-automatic.timer >/dev/null 2>&1 && grep -Eq '^[[:space:]]*apply_updates[[:space:]]*=[[:space:]]*yes' /etc/dnf/automatic.conf; then echo auto=yes; else echo auto=no; fi
    fi
    printf '#HOPLINE-SOURCE dnf\n'; bounded 20 dnf -C -q updateinfo list --security 2>/dev/null && echo pending-complete=yes || printf '#HOPLINE-PARTIAL security update query unavailable (20s limit; timeout utility or cached metadata may be missing)\n'
  elif command -v yum >/dev/null 2>&1; then
    collect_yum_auto
    printf '#HOPLINE-SOURCE yum\n'
    # Disable plugins and force cache-only operation: never refresh metadata or install updates.
    # KILL makes the 20-second limit hold even if yum ignores TERM.
    pending=$(bounded -s KILL 20 yum -C -q --noplugins --setopt=logfile=/dev/null updateinfo list security 2>/dev/null)
    if [ $? -eq 0 ]; then
      printf '%s\n' "$pending"
      if printf '%s\n' "$pending" | grep -Eiq '^[[:space:]]*[^[:space:]]+[[:space:]]+([^[:space:]]*/Sec[.]|security)[[:space:]]'; then echo pending-complete=yes
      else printf '#HOPLINE-PARTIAL yum 未返回安全公告；本地安全元数据可能缺失，不能确认待装更新为零\n'; fi
    else printf '#HOPLINE-PARTIAL yum 安全更新查询失败或超时（20 秒上限；可能缺少 timeout 或本地缓存）\n'; fi
  else unavailable not-applicable 'package manager unsupported'; fi
  if [ -e /var/run/reboot-required ]; then echo reboot=yes; else echo reboot=no; fi
}
collect_bruteforce() {
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f '(^|/)(fail2ban-server|sshguard)( |$)' >/dev/null; then echo active=yes; else echo active=no; fi
  else unavailable not-installed pgrep; fi
}
collect_accounts() {
  awk -F: '$3==0 {print "uid0=" $1}' /etc/passwd 2>/dev/null || unavailable permission-denied passwd
  if [ -r /etc/shadow ]; then awk -F: '$2=="" {print "empty=" $1} END {print "shadow=readable"}' /etc/shadow
  else echo shadow=permission-denied; fi
}
collect_processes() {
  # BusyBox ps has no pcpu column; fall back so miner detection still works on Alpine.
  processes=$(ps -A -o pid,user,pcpu,comm,args 2>/dev/null) || processes=$(ps -o pid,user,comm,args 2>/dev/null) || { unavailable error ps; return; }
  printf '%s\n' "$processes" | head -n 200
  [ "$(printf '%s\n' "$processes" | wc -l)" -le 200 ] || printf '#HOPLINE-PARTIAL first 200 process rows only\n'
}
` + CERT_SCRIPT + String.raw`
collect_tls() {
  collect_certs
  domains=$(printf '%s\n' "$config" | sed 's/#.*//' | awk '{for(i=1;i<NF;i++) if($i=="server_name") for(j=i+1;j<=NF;j++) {end=($j ~ /;/); gsub(/;/,"",$j); print $j; if(end) break}}' | sort -u | head -n 10)
  domains=$(printf '%s\n%s\n' "$domains" "$(printf '%s\n' "$caddy_files" | sed 's|.*/||; s/\.crt$//')" | sort -u | head -n 10)
  tls_listeners=$(ss -Htln 2>/dev/null || netstat -tln 2>/dev/null) || printf '#HOPLINE-PARTIAL TLS listener list unavailable\n'
  addresses=$(printf '%s\n' "$tls_listeners" | awk '$4 ~ /:443$/ {print $4}' | sort -u)
  count=0
  for address in $addresses; do
    case "$address" in '0.0.0.0:443'|'*:443') address=127.0.0.1:443;; '[::]:443'|':::443') address='[::1]:443';; esac
    case "$address" in *[!0-9a-fA-F.:\[\]]*) continue;; esac
    for domain in $domains; do
      [ "$count" -lt 10 ] || break
      case "$domain" in ''|*[!a-zA-Z0-9.-]*|-*) continue;; esac
      count=$((count+1))
      cert=$(bounded 3 openssl s_client -connect "$address" -servername "$domain" </dev/null 2>/dev/null | openssl x509 -noout -enddate -subject 2>/dev/null)
      if [ -n "$cert" ]; then printf '#HOPLINE-CERT served\n%s\n' "$cert"; else printf '#HOPLINE-PARTIAL TLS handshake unavailable\n'; fi
    done
  done
  if [ -n "$addresses" ] && [ "$count" -eq 0 ]; then printf '#HOPLINE-PARTIAL no usable TLS server names\n'; fi
}
for name in os sshd firewall listeners updates bruteforce accounts processes tls; do section "$name"; done
`

// The standalone distro probe also benefits from non-interactive sudo.
export const SECURITY_SCRIPT = `#!/bin/sh
if [ "$(id -u)" != 0 ] && sudo -n true 2>/dev/null; then exec sudo -n sh -c ${shellEscape(script)}; fi
${script}`
