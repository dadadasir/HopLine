import { CERT_SCRIPT } from '../security/certs'
export const COLLECT_SCRIPT = String.raw`#!/bin/sh
export LC_ALL=C
unavailable() { printf '#HOPLINE-UNAVAILABLE %s %s\n' "$1" "$2"; }
run() {
  err=$("$@" 2>&1 1>&3)
  code=$?
  printf '\n'
  if [ "$code" -ne 0 ]; then
    reason=error
    case "$err" in *'Permission denied'*|*'permission denied'*|*'Operation not permitted'*) reason=permission-denied ;; esac
    [ "$code" -eq 127 ] && reason=not-installed
    unavailable "$reason" "$(printf '%.200s' "$err" | tr '\n\r' '  ')"
  elif [ -n "$err" ]; then
    printf '#HOPLINE-PARTIAL %s\n' "$(printf '%.200s' "$err" | tr '\n\r' '  ')"
  fi
  return "$code"
} 3>&1
section() { printf '===HOPLINE:%s===\n' "$1"; "collect_$1"; printf '\n#HOPLINE-END\n'; }
collect_os() { run cat /etc/os-release; run uname -srm; }
collect_uptime() { run cat /proc/uptime; }
collect_cpu() {
  cores=$(nproc 2>/dev/null) || cores=$(awk '/^processor[[:space:]]*:/ {n++} END {if (n) print n; else exit 1}' /proc/cpuinfo 2>/dev/null)
  printf 'cores %s\n' "$cores"
  run head -n 1 /proc/stat
  run sleep 1
  run head -n 1 /proc/stat
}
collect_memory() { run cat /proc/meminfo; }
collect_load() { run cat /proc/loadavg; }
collect_disk() { run df -P -k; printf '#HOPLINE-MOUNTS\n'; run cat /proc/mounts; }
collect_listeners() {
  if command -v ss >/dev/null 2>&1; then run ss -Htlnp
  elif command -v netstat >/dev/null 2>&1; then run netstat -tlnp
  else unavailable not-installed 'ss and netstat'; fi
}
collect_docker() { run docker ps --format '{{json .}}'; }
collect_services() {
  if [ ! -r /proc/1/comm ]; then run cat /proc/1/comm
  elif [ "$(cat /proc/1/comm)" = systemd ]; then run systemctl list-units --type=service --state=running --no-legend --plain
  else unavailable not-applicable 'PID 1 is not systemd'; fi
}
collect_web() {
  found=0
  for dir in /etc/nginx /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/caddy; do
    if [ -d "$dir" ] && { [ ! -r "$dir" ] || [ ! -x "$dir" ]; }; then unavailable permission-denied "$dir"; found=1; fi
  done
  for file in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /etc/caddy/Caddyfile; do
    [ -e "$file" ] || [ -L "$file" ] || continue
    [ -d "$file" ] && continue
    found=1
    case "$file" in */Caddyfile) printf '#HOPLINE-SOURCE caddy\n' ;; *) printf '#HOPLINE-SOURCE nginx\n' ;; esac
    run cat "$file"
    printf '\n'
  done
  [ "$found" -eq 1 ] || unavailable not-installed 'nginx and caddy configuration'
}
` + CERT_SCRIPT + String.raw`
for name in os uptime cpu memory load disk listeners docker services web certs; do section "$name"; done
`
