/** The daemon's JSON log name is derived from a full container ID, never LogPath. */
function containerLogs(apply: boolean): string {
  return `set -eu
export LC_ALL=C
# Failures stay unknown; do not publish daemon paths or raw inspect diagnostics.
exec 2>/dev/null
for tool in docker stat awk truncate; do command -v "$tool" >/dev/null 2>&1 || exit 20; done
docker_root=$(docker info --format '{{.DockerRootDir}}') || exit 20
case "$docker_root" in (''|/|*[[:cntrl:]]*) exit 20 ;; (/*) : ;; (*) exit 20 ;; esac
[ -d "$docker_root" ] && [ ! -L "$docker_root" ] || exit 20
cd -P "$docker_root" || exit 20
[ "$(pwd -P)" = "$docker_root" ] || exit 20
root_identity=$(stat -c '%d:%i' .) || exit 20
case "$root_identity" in (*[!0-9:]*|:*|*:|*:*:*) exit 20 ;; (*:*) : ;; (*) exit 20 ;; esac
device=\${root_identity%%:*}
ids=$(docker container ls -aq --no-trunc) || exit 20
json_count=0; local_count=0; journal_count=0; other_count=0; sizes=''; seen=''
if [ -n "$ids" ]; then
  container_root="$docker_root/containers"
  [ -d ./containers ] && [ ! -L ./containers ] || exit 20
  cd -P ./containers || exit 20
  [ "$(pwd -P)" = "$container_root" ] || exit 20
  container_identity=$(stat -c '%d:%i' .) || exit 20
  case "$container_identity" in (*[!0-9:]*|:*|*:|*:*:*) exit 20 ;; (*:*) : ;; (*) exit 20 ;; esac
  [ "\${container_identity%%:*}" = "$device" ] || exit 20
  while IFS= read -r id; do
    case "$id" in (''|*[!a-f0-9]*) exit 20 ;; esac
    [ "\${#id}" -eq 64 ] || exit 20
    case " $seen " in (*" $id "*) exit 20 ;; esac
    seen="$seen $id"
    info=$(docker container inspect --format '{{.Id}} {{.HostConfig.LogConfig.Type}}' "$id") || exit 20
    case "$info" in ("$id "*) driver=\${info#"$id "} ;; (*) exit 20 ;; esac
    case "$driver" in (''|*[!a-zA-Z0-9_.:/@+-]*) exit 20 ;; esac
    case "$driver" in
      (json-file) json_count=$((json_count + 1)) ;;
      (local) local_count=$((local_count + 1)); continue ;;
      (journald) journal_count=$((journal_count + 1)); continue ;;
      (*) other_count=$((other_count + 1)); continue ;;
    esac
    [ "$(pwd -P)" = "$container_root" ] && [ "$(stat -c '%d:%i' .)" = "$container_identity" ] || exit 20
    [ -d "./$id" ] && [ ! -L "./$id" ] || exit 20
    cd -P "./$id" || exit 20
    expected_dir="$container_root/$id"
    [ "$(pwd -P)" = "$expected_dir" ] || exit 20
    directory_identity=$(stat -c '%d:%i' .) || exit 20
    case "$directory_identity" in (*[!0-9:]*|:*|*:|*:*:*) exit 20 ;; (*:*) : ;; (*) exit 20 ;; esac
    [ "\${directory_identity%%:*}" = "$device" ] || exit 20
    name="$id-json.log"
    [ ! -L "./$name" ] || exit 20
    if [ -e "./$name" ]; then
      [ -f "./$name" ] || exit 20
      identity=$(stat -c '%d:%i:%h' "./$name") || exit 20
      inode=\${identity#*:}; inode=\${inode%:*}
      case "$inode" in (''|*[!0-9]*) exit 20 ;; esac
      # A hard link could share its inode with application or volume data.
      [ "$identity" = "$device:$inode:1" ] || exit 20
      # Read-only open neither truncates nor creates a file if it was replaced.
      # Children inherit this descriptor; /proc/self refers to each child.
      exec 3<"./$name" || exit 20
      [ "$(stat -Lc '%d:%i:%h' /proc/self/fd/3)" = "$identity" ] || exit 20
      size=$(stat -Lc %s /proc/self/fd/3) || exit 20
      case "$size" in (''|*[!0-9]*) exit 20 ;; esac
      [ "$(pwd -P)" = "$expected_dir" ] && [ "$(stat -c '%d:%i' .)" = "$directory_identity" ] || exit 20
      [ "$(stat -c '%d:%i' "$docker_root")" = "$root_identity" ] && [ ! -L "$docker_root" ] || exit 20
      [ ! -L "./$name" ] && [ "$(stat -c '%d:%i:%h' "./$name")" = "$identity" ] || exit 20
      ${apply ? 'truncate -s 0 -- /proc/self/fd/3 || exit 20' : `sizes="$sizes$size
"`}
      exec 3<&-
    fi
    cd -P "$container_root" || exit 20
  done <<EOF_CONTAINERS
$ids
EOF_CONTAINERS
fi
${apply ? '' : `bytes=$(printf '%s' "$sizes" | awk '
  /^[0-9]+$/ {sum += $1; if (sum > 9007199254740991) exit 20; next}
  {exit 20}
  END {if (sum <= 9007199254740991) printf "%.0f", sum + 0}
') || exit 20`}
log_drivers="json-file=$json_count local=$local_count journald=$journal_count other=$other_count"`
}

/** The shared step emits bytes first, then these non-path diagnostic counts. */
export const cleanupDockerLogScripts = {
  measure: containerLogs(false),
  apply: containerLogs(true),
  details: `printf 'drivers=%s\\n' "$log_drivers"`
}
