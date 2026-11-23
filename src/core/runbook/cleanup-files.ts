import { shellEscape } from '../shell'

/** Only these fixed roots may be used by the built-in cleanup items. */
export const cleanupFileTargets = [
  { id: 'rotated-logs', root: '/var/log', rotated: true },
  { id: 'crash-reports', root: '/var/crash', rotated: false },
  { id: 'coredumps', root: '/var/lib/systemd/coredump', rotated: false }
] as const
export type CleanupFileTarget = typeof cleanupFileTargets[number]

/** Shared traversal/filter for check and apply. File names never become shell source or lines. */
function selectedFiles(target: CleanupFileTarget, remove: boolean): string {
  const occupancyProbe = target.rotated ? `
occupancy_tool=''
if command -v fuser >/dev/null 2>&1; then
  version=$(fuser --help 2>&1 || :)
  # BusyBox fuser silently ignores unreadable /proc/PID/fd entries, so a
  # no-match result cannot establish that a rotated log is not being written.
  case "$version" in (*[Bb][Uu][Ss][Yy][Bb][Oo][Xx]*) : ;; (*) occupancy_tool=fuser ;; esac
fi
if [ -z "$occupancy_tool" ]; then
  command -v lsof >/dev/null 2>&1 || exit 20
  version=$(lsof -v 2>&1 || :)
  case "$version" in (*[Bb][Uu][Ss][Yy][Bb][Oo][Xx]*) exit 20 ;; esac
  occupancy_tool=lsof
fi
export occupancy_tool` : ''
  const occupancy = target.rotated ? `
    # Rotation suffixes alone do not prove a file is no longer being written.
    # An occupied file is skipped; uncertain tool output fails the whole item.
    if [ "$occupancy_tool" = fuser ]; then
      busy=$(fuser "./$name" 2>&1) && exit 0; code=$?
    else
      busy=$(lsof -t -- "./$name" 2>&1) && exit 0; code=$?
    fi
    [ "$code" = 1 ] && [ -z "$busy" ] || exit 20` : ''
  const action = `set -eu
export LC_ALL=C
# BusyBox can lose the failure status of an earlier full -exec batch. Carry
# failures in stdout too, so a later successful batch cannot conceal them.
trap 'action_status=$?; if [ "$action_status" -ne 0 ]; then printf "%s\\n" HOPLINE_CLEANUP_FILE_ERROR; fi; exit "$action_status"' 0
root=$1; expected=$2; device=$3; shift 3
[ "$(stat -c '%d:%i' .)" = "$expected" ] || exit 20
for file do
  case "$file" in ./*) ;; *) exit 20 ;; esac
  parent=\${file%/*}; name=\${file##*/}
  (
    # Anchor the parent directory before touching the basename, so replacement
    # of a traversed directory with a symlink cannot redirect the operation.
    cd -P "$parent" || exit 20
    physical=$(pwd -P) || exit 20
    wanted=$root
    [ "$parent" = . ] || wanted="$root/\${parent#./}"
    [ "$physical" = "$wanted" ] || exit 20
    [ -f "./$name" ] && [ ! -L "./$name" ] || exit 20
    before=$(stat -c '%d:%i:%s:%Y' "./$name") || exit 20
    ${occupancy}
    [ "$(stat -c %d "./$name")" = "$device" ] || exit 20
    [ "$before" = "$(stat -c '%d:%i:%s:%Y' "./$name")" ] && [ ! -L "./$name" ] || exit 20
    ${remove ? 'rm -- "./$name" || exit 20' : 'stat -c %s "./$name" || exit 20'}
  ) || exit 20
done`
  const filter = target.rotated
    ? "-path './journal' -prune -o -type f \\( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \\)"
    : '-type f'
  return `(
set -eu
export LC_ALL=C
root=${shellEscape(target.root)}
${occupancyProbe}
[ ! -L "$root" ] || exit 20
if [ ! -e "$root" ]; then exit 0; fi
[ -d "$root" ] || exit 20
cd -P "$root" || exit 20
[ "$(pwd -P)" = "$root" ] || exit 20
[ -r . ] && [ -x . ] || exit 20
expected=$(stat -c '%d:%i' .) || exit 20
device=$(stat -c %d .) || exit 20
# BusyBox only flushes batched -exec actions at the top expression level.
# Keep only the name alternatives grouped; -a binds more tightly than -o.
find . -xdev ${filter} -exec sh -c ${shellEscape(action)} sh "$root" "$expected" "$device" {} + || exit 20
)`
}

export function cleanupFileScripts(target: CleanupFileTarget): { measure: string; apply: string } {
  return {
    measure: `sizes=$(\n${selectedFiles(target, false)}\n) || exit 20
case "$sizes" in *[!0-9[:space:]]*) exit 20 ;; esac
bytes=$(printf '%s\\n' "$sizes" | awk '{s+=$1} END {printf "%.0f", s}')`,
    apply: `output=$(\n${selectedFiles(target, true)}\n) || exit 20
[ -z "$output" ] || exit 20`
  }
}
