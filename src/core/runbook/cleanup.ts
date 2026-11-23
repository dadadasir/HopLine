import { shellEscape } from '../shell'
import { cleanupFileScripts, cleanupFileTargets } from './cleanup-files'
import { cleanupDockerLogScripts } from './cleanup-docker-logs'
import { envCommand } from './engine'
import type { Exec, Runbook, RunbookStep } from './types'

export interface CleanupLogDrivers { jsonFile: number; local: number; journald: number; other: number }
export interface CleanupEstimate { bytes: number | null; details: string; unavailable?: boolean; logDrivers?: CleanupLogDrivers }
export interface CleanupChange { before: number | null; after: number | null }
export function parseCleanup(output: string): CleanupEstimate {
  const [first, ...lines] = output.split(/\r?\n/), match = /^bytes=(\d+)$/.exec(first)
  const bytes = match ? Number(match[1]) : NaN
  const result: CleanupEstimate = { bytes: Number.isSafeInteger(bytes) ? bytes : null, details: lines.join('\n').trim() }
  const driverLines = lines.filter(line => line.startsWith('drivers='))
  if (driverLines.length) {
    const counts = driverLines.length === 1 ? /^drivers=json-file=(\d+) local=(\d+) journald=(\d+) other=(\d+)$/.exec(driverLines[0])?.slice(1).map(Number) : undefined
    if (!counts || !counts.every(Number.isSafeInteger) || !Number.isSafeInteger(counts.reduce((sum, count) => sum + count, 0))) result.bytes = null
    else result.logDrivers = { jsonFile: counts[0], local: counts[1], journald: counts[2], other: counts[3] }
  }
  return result
}
export const cleanupDefaults = ['docker-build-cache', 'docker-dangling-images', 'journal', 'apt-cache', 'dnf-cache', 'apk-cache', 'crash-reports', 'coredumps']
const unavailable = 'echo cleanup.unavailable; exit 30'
const unsupported = 'echo cleanup.unsupported; exit 30'
const sizeSum = `awk '{s+=$1} END {printf "%.0f", s}'`
const humanBytes = `awk 'function bytes(s, n,u) {n=s+0; u=s; sub(/^[0-9.]+/, "", u); if(u=="B"||u=="") return n; if(u=="kB") return n*1000; if(u=="MB") return n*1000000; if(u=="GB") return n*1000000000; if(u=="TB") return n*1000000000000; if(u=="K") return n*1024; if(u=="M") return n*1048576; if(u=="G") return n*1073741824; exit 20} {printf "%.0f", bytes($1)}'`
const docker = `command -v docker >/dev/null 2>&1 || { ${unavailable}; }
docker info >/dev/null 2>&1 || exit 20`
// POSIX awk has no portable mktime(). Convert validated RFC3339 to epoch using
// the Gregorian calendar; Docker timestamps may include fractions or offsets.
const imageCreatedEpoch = `awk '
function leap(y) { return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) }
function epoch(y,m,d,h,n,s,offset, a,yy,mm,days) {
  a=int((14-m)/12); yy=y+4800-a; mm=m+12*a-3
  days=d+int((153*mm+2)/5)+365*yy+int(yy/4)-int(yy/100)+int(yy/400)-32045-2440588
  return days*86400+h*3600+n*60+s-offset
}
{
  if (NR != 1 || $0 !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9](\\.[0-9]+)?(Z|[+-][0-9][0-9]:[0-9][0-9])$/) exit 1
  y=substr($0,1,4)+0; m=substr($0,6,2)+0; d=substr($0,9,2)+0
  h=substr($0,12,2)+0; n=substr($0,15,2)+0; s=substr($0,18,2)+0
  limit=(m==2 ? 28+leap(y) : (m==4 || m==6 || m==9 || m==11 ? 30 : 31))
  if (y<1970 || m<1 || m>12 || d<1 || d>limit || h>23 || n>59 || s>59) exit 1
  offset=0
  if (substr($0,length($0),1)!="Z") {
    zone=substr($0,length($0)-5); zh=substr(zone,2,2)+0; zm=substr(zone,5,2)+0
    if (zh>23 || zm>59) exit 1
    offset=(zh*60+zm)*60*(substr(zone,1,1)=="-" ? -1 : 1)
  }
  printf "%.0f\\n", epoch(y,m,d,h,n,s,offset)
}'`
const distro = `test -r /etc/os-release || { ${unsupported}; }
ID=''; ID_LIKE=''
. /etc/os-release
case " $ID $ID_LIKE " in
  *' debian '*|*' ubuntu '*) family=apt ;;
  *' rhel '*|*' fedora '*|*' centos '*|*' rocky '*|*' almalinux '*|*' amzn '*) family=rpm ;;
  *' alpine '*) family=apk ;;
  *) ${unsupported} ;;
esac`
const rpmCache = `${distro}
[ "$family" = rpm ] || { ${unavailable}; }
if command -v dnf >/dev/null 2>&1; then manager=dnf; cache_dir=/var/cache/dnf
elif command -v yum >/dev/null 2>&1; then manager=yum; cache_dir=/var/cache/yum
else ${unavailable}; fi`
const kernels = `test -r /etc/os-release || exit 20
. /etc/os-release
case "$ID" in debian|ubuntu) ;; *) ${unavailable} ;; esac
running=$(uname -r)
installed=$(dpkg-query -W -f='\${db:Status-Status} \${Package} \${Installed-Size}\\n' 'linux-*') || exit 20
latest=$(printf '%s\\n' "$installed" | awk '$1=="installed" && $2 ~ /^linux-image-[0-9]/ {sub(/^linux-image-/, "", $2); print $2}' | sort -V | tail -1)
[ -n "$latest" ] || exit 20
printf '%s\\n' "$installed" | grep -q "installed linux-image-$running " || exit 20
simulation=$(apt-get -s autoremove --purge) || exit 20
removals=$(printf '%s\\n' "$simulation" | awk '$1=="Remv" || $1=="Purg" {print $2}')
bytes=0
for pkg in $removals; do
  case "$pkg" in *"$running"*|*"$latest"*) exit 20 ;; esac
  case "$pkg" in linux-image-[0-9]*|linux-modules-[0-9]*|linux-modules-extra-[0-9]*|linux-headers-[0-9]*) ;; *) exit 20 ;; esac
  size=$(printf '%s\\n' "$installed" | awk -v p="$pkg" '$1=="installed" && $2==p {print $3}')
  case "$size" in ''|*[!0-9]*) exit 20 ;; esac
  bytes=$((bytes + size * 1024))
done`
const tmpPrerequisite = `command -v lsof >/dev/null 2>&1 || command -v fuser >/dev/null 2>&1 || exit 20`
const tmpFiles = (remove: boolean) => `find /tmp -xdev -type f -mtime +7 -exec sh -c ${shellEscape(`for f do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  before=$(stat -c '%d:%i:%s:%Y' "$f") || exit 20
  # Prefer fuser: BusyBox lsof ignores -t and file arguments and would mark every file busy.
  if command -v fuser >/dev/null 2>&1; then busy=$(fuser "$f" 2>&1) && continue; code=$?
  elif lsof -v 2>&1 | grep -qi busybox; then echo uncertain; exit 20
  else busy=$(lsof -t -- "$f" 2>&1) && continue; code=$?; fi
  [ "$code" = 1 ] && [ -z "$busy" ] || { echo uncertain; exit 20; }
  [ "$before" = "$(stat -c '%d:%i:%s:%Y' "$f")" ] || { echo uncertain; exit 20; }
  ${remove ? 'rm -- "$f" || exit 20' : 'stat -c %s "$f" || exit 20'}
done`)} sh {} +`
function step(id: string, measure: string, apply: string, prerequisite = '', risk = 'safe', details = ''): RunbookStep {
  const body = `set -eu\nexport LC_ALL=C\n${prerequisite}\n${measure}\nprintf 'bytes=%s\\n%s: %s bytes\\n' "$bytes" ${shellEscape(id.replaceAll('-', ' '))} "$bytes"\n${details}\n[ "$bytes" -eq 0 ] && exit 0\nexit 10`
  // Legacy callers check without prompting. Privileged planning wraps this
  // check in sudo -S; the root branch then executes the same read-only body.
  // Keep one copy: repeated shell escaping through sudo and supervision can
  // otherwise exceed the SSH request packet limit for the fixed-file checks.
  const check = `# cleanup:${id}\ncleanup_script=${shellEscape(body)}\nif [ "$(id -u)" = 0 ]; then sh -c "$cleanup_script"; else sudo -n sh -c "$cleanup_script"; fi`
  return { id, title: `cleanup.${id}`, description: risk === 'medium' ? `cleanup.risk.${id}` : `cleanup.${risk}`, sudo: true, check,
    apply: `set -eu\nexport LC_ALL=C\n${prerequisite}\n${apply}`, verify: `${check}\n# cleanup:verify`, dangerous: risk === 'medium' }
}
export const cleanupRunbook: Runbook = { id: 'cleanup', title: 'cleanup.title', steps: [
  step('docker-build-cache', `usage=$(docker system df --format '{{if eq .Type "Build Cache"}}{{.Reclaimable}}{{end}}') || exit 20
bytes=$(printf '%s\\n' "$usage" | awk 'NF {print $1}' | ${humanBytes})
[ -n "$bytes" ] || exit 20`, 'docker builder prune -f', docker),
  step('docker-dangling-images', `ids=$(docker image ls -q --filter dangling=true) || exit 20
sizes=0
[ -z "$ids" ] || sizes=$(docker image inspect --format '{{.Size}}' $ids) || exit 20
bytes=$(printf '%s\\n' "$sizes" | ${sizeSum})`, 'docker image prune -f', docker),
  step('docker-container-logs', cleanupDockerLogScripts.measure, cleanupDockerLogScripts.apply, docker, 'medium', cleanupDockerLogScripts.details),
  step('docker-unused-images', `containers=$(docker container ls -aq) || exit 20
used=''
[ -z "$containers" ] || used=$(docker container inspect --format '{{.Image}}' $containers) || exit 20
images=$(docker image ls -aq --no-trunc) || exit 20
ids=$(printf '%s\\n' "$images" | sort -u)
cutoff=$(($(date +%s) - 604800)); bytes=0
for id in $ids; do
  info=$(docker image inspect --format '{{.Id}} {{.Size}} {{.Created}}' "$id") || exit 20
  set -- $info
  [ "$#" -eq 3 ] || exit 20
  case "$2" in ''|*[!0-9]*) exit 20 ;; esac
  printf '%s\\n' "$used" | grep -Fxq "$1" && continue
  created=$(printf '%s\\n' "$3" | ${imageCreatedEpoch}) || exit 20
  [ -n "$created" ] || exit 20
  if [ "$created" -lt "$cutoff" ]; then bytes=$((bytes + $2)); fi
done`, 'docker image prune -a -f --filter until=168h', docker, 'medium'),
  step('journal', `# Mirror journald's vacuum: only archived files count toward the 200 MiB limit; oldest whole files go first, by allocated size.
list=$(for dir in /var/log/journal /run/log/journal; do
  [ -d "$dir" ] || continue
  find "$dir" -xdev -type f -name '*.journal*' -exec stat -c '%Y %b %B %n' {} + || exit 20
done) || exit 20
bytes=$(printf '%s\\n' "$list" | sort -n | awk -v limit=209715200 '
  NF >= 4 && ($4 ~ /@/ || $4 ~ /~$/) { size = $2 * $3; total += size; n++; sizes[n] = size; arch[n] = 1 }
  END { for (i = 1; i <= n && total > limit; i++) if (arch[i]) { total -= sizes[i]; freed += sizes[i] } printf "%.0f", freed + 0 }')`, 'journalctl --vacuum-size=200M', `command -v journalctl >/dev/null 2>&1 || { ${unavailable}; }`, 'low'),
  step('apt-cache', `bytes=0
if [ -d /var/cache/apt/archives ]; then
  sizes=$(find /var/cache/apt/archives -xdev -type f ! -name lock -exec stat -c %s {} +) || exit 20
  bytes=$(printf '%s\\n' "$sizes" | ${sizeSum})
elif [ -e /var/cache/apt/archives ]; then exit 20; fi`, 'apt-get clean', `${distro}\n[ "$family" = apt ] || { ${unavailable}; }\ncommand -v apt-get >/dev/null 2>&1 || { ${unavailable}; }`),
  step('dnf-cache', `bytes=0
if [ -d "$cache_dir" ]; then
  sizes=$(find "$cache_dir" -xdev -type f -path '*/packages/*' -name '*.rpm' -exec stat -c %s {} +) || exit 20
  bytes=$(printf '%s\\n' "$sizes" | ${sizeSum})
elif [ -e "$cache_dir" ]; then exit 20; fi`, '"$manager" clean packages', rpmCache),
  step('apk-cache', `directories=''
for dir in /var/cache/apk /etc/apk/cache; do
  [ -d "$dir" ] || continue
  canonical=$(readlink -f "$dir") || exit 20
  case "$canonical" in *[[:space:]]*) exit 20 ;; esac
  directories="$directories $canonical"
done
simulation=$(apk -vv --simulate cache clean 2>&1) || exit 20
names=$(printf '%s\\n' "$simulation" | sed -n 's/.*[Dd]eleting //p' | sort -u)
bytes=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  case "$name" in */*|.|..) exit 20 ;; esac
  found=0; previous=''
  for cache in $directories; do
    [ "$cache" != "$previous" ] || continue
    previous=$cache
    [ -f "$cache/$name" ] && [ ! -L "$cache/$name" ] || continue
    size=$(stat -c %s "$cache/$name") || exit 20
    bytes=$((bytes + size)); found=1
  done
  [ "$found" = 1 ] || exit 20
done <<EOF_NAMES
$names
EOF_NAMES`, 'apk cache clean', `${distro}\n[ "$family" = apk ] || { ${unavailable}; }\ncommand -v apk >/dev/null 2>&1 || { ${unavailable}; }`),
  step('old-kernels', kernels, `${kernels}\n[ "$bytes" -gt 0 ] || exit 0\napt-get autoremove --purge -y`, '', 'medium'),
  step('tmp-old', `sizes=$(${tmpFiles(false)}) || exit 20
case "$sizes" in *[!0-9[:space:]]*) exit 20 ;; esac
bytes=$(printf '%s\\n' "$sizes" | ${sizeSum})`, tmpFiles(true), tmpPrerequisite, 'medium'),
  ...cleanupFileTargets.map((target) => {
    const scripts = cleanupFileScripts(target)
    return { ...step(target.id, scripts.measure, scripts.apply, '', target.rotated ? 'medium' : 'low'), description: `cleanup.risk.${target.id}` }
  })
] }

/** Keep measurements outside the generic engine: it only retains the first check line. */
export function cleanupExecution(execute: Exec) {
  const estimates: Record<string, CleanupEstimate> = {}, changes: Record<string, CleanupChange> = {}
  const exec: Exec = async (script, options) => {
    const step = cleanupRunbook.steps.find((s) => [s.check, s.verify].some((text) => script === text || options.env.HL_SCRIPT === envCommand(text, {})))
    const result = await execute(script, options)
    if (!step) return result
    const verify = script === step.verify || options.env.HL_SCRIPT === envCommand(step.verify, {})
    const valid = !result.timedOut && !result.signal && !('truncated' in result && result.truncated)
    const value = parseCleanup(result.stdout), unavailable = valid && result.code === 30
    if (!valid || ![0, 10].includes(result.code ?? -1)) value.bytes = null
    if (!verify) {
      estimates[step.id] = { ...value, unavailable }
      changes[step.id] = { before: value.bytes, after: null }
    } else changes[step.id] = { before: changes[step.id]?.before ?? null, after: value.bytes }
    const before = changes[step.id]?.before
    const code = verify ? value.bytes !== null && (value.bytes === 0 || before != null && value.bytes < before) ? 0 : 20
      : unavailable ? 10 : value.bytes === null ? 20 : value.bytes === 0 ? 0 : 10
    return { ...result, code }
  }
  return { exec, estimates, changes }
}

export function cleanupDuCommand(mount: string): string {
  if (typeof mount !== 'string' || !mount.startsWith('/') || /[\0\r\n]/.test(mount) || mount.length > 4096) throw new Error('cleanup.invalidMount')
  // Sort in the client so a timeout still preserves directories already emitted by du.
  return `set -eu
export LC_ALL=C
if du -k -x -d 0 /dev/null >/dev/null 2>&1; then set -- du -k -x -d 2 ${shellEscape(mount)}
else set -- du -k -x ${shellEscape(mount)}; fi
if command -v ionice >/dev/null 2>&1 && ionice -c3 true >/dev/null 2>&1; then
  exec ionice -c3 nice -n 19 "$@" 2>/dev/null
else exec nice -n 19 "$@" 2>/dev/null; fi`
}
export function cleanupDuOutput(output: string, mount?: string): string {
  const root = mount?.replace(/\/+$/, '') || '/'
  return output.slice(0, output.lastIndexOf('\n') + 1).split('\n').filter((line) => {
    const match = /^(\d+)\s+(\/.*)$/.exec(line)
    if (!match) return false
    if (!mount) return true
    const directory = match[2].replace(/\/+$/, '') || '/'
    const relative = directory === root ? '' : directory.startsWith(root === '/' ? '/' : `${root}/`) ? directory.slice(root === '/' ? 1 : root.length + 1) : null
    return relative !== null && (!relative || relative.split('/').length <= 2)
  }).sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 20).join('\n')
}
