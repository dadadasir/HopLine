import type { Runbook } from './types'

const readTimezone = `read_timezone() {
  current=$(timedatectl show -p Timezone --value 2>/dev/null) || current=
  if [ -z "$current" ]; then
    link=$(readlink /etc/localtime 2>/dev/null) || link=
    case "$link" in */zoneinfo/*) current=\${link#*/zoneinfo/};; esac
  fi
  if [ -z "$current" ] && [ -r /etc/timezone ]; then IFS= read -r current < /etc/timezone; fi
  case "$current" in ''|*[!A-Za-z_/+-]*) return 1;; esac
  [ -f "/usr/share/zoneinfo/$current" ]
}`
const setTimezone = `set_timezone() {
  if command -v timedatectl >/dev/null 2>&1; then timedatectl set-timezone "$1"
  else
    printf '%s\\n' "$1" > /etc/timezone && ln -snf "/usr/share/zoneinfo/$1" /etc/localtime
  fi
}`
export const timezoneRunbook: Runbook = {
  id: 'timezone', title: 'runbook.timezone',
  params: [{ name: 'TZ', label: 'runbook.tz', pattern: '^[A-Za-z_]+(/[A-Za-z_+-]+)*$' }],
  steps: [{
    id: 'timezone', title: 'runbook.timezone', sudo: true,
    check: `${readTimezone}
read_timezone || exit 20
printf '%s\\n' "$current"
[ -f "/usr/share/zoneinfo/\${HL_TZ}" ] || exit 20
[ "$current" = "\${HL_TZ}" ] && exit 0
exit 10`,
    apply: `${readTimezone}
${setTimezone}
read_timezone || exit 1
[ -f "/usr/share/zoneinfo/\${HL_TZ}" ] || exit 1
# Never follow an untrusted /tmp link or overwrite another user's file.
if [ -e /tmp/hopline-tz-prev ] || [ -L /tmp/hopline-tz-prev ]; then
  [ ! -L /tmp/hopline-tz-prev ] && [ -f /tmp/hopline-tz-prev ] && [ "$(stat -c '%u:%h' /tmp/hopline-tz-prev)" = '0:1' ] || exit 1
else
  (umask 077; set -C; : > /tmp/hopline-tz-prev) || exit 1
fi
printf '%s\\n' "$current" > /tmp/hopline-tz-prev || exit 1
set_timezone "\${HL_TZ}"`,
    verify: `${readTimezone}
read_timezone && [ "$current" = "\${HL_TZ}" ]`,
    rollback: `${setTimezone}
[ ! -L /tmp/hopline-tz-prev ] && [ "$(stat -c '%u:%h' /tmp/hopline-tz-prev)" = '0:1' ] || exit 1
IFS= read -r previous < /tmp/hopline-tz-prev || exit 1
case "$previous" in ''|*[!A-Za-z_/+-]*) exit 1;; esac
[ -f "/usr/share/zoneinfo/$previous" ] && set_timezone "$previous"`
  }]
}
