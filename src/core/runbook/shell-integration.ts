import { shellEscape } from '../shell'
import { bashIntegration, zshIntegration } from '../shell-integration'
import type { Runbook } from './types'

export const integrationStart = '# >>> hopline shell integration >>>'
export const integrationEnd = '# <<< hopline shell integration <<<'
const setup = `set -eu
case "\${SHELL##*/}" in bash) rc="$HOME/.bashrc"; syntax=bash;; zsh) rc="$HOME/.zshrc"; syntax=zsh;; *) echo 'shellIntegration.unsupported'; exit 1;; esac
backup="$rc.hopline-backup"
[ ! -L "$rc" ] && [ ! -L "$backup" ] || exit 1
[ ! -e "$rc" ] || [ -f "$rc" ] || exit 1
absent=0
if [ ! -e "$rc" ] || { [ -f "$rc" ] && sed -n '/^${integrationStart}$/,/^${integrationEnd}$/p' "$rc" | grep -qx '# hopline original rc absent: 1'; }; then absent=1; fi`
const block = (script: string) => `${shellEscape(integrationStart)}"\n# hopline original rc absent: $absent\n"${shellEscape(`${script}\n${integrationEnd}`)}`
const desired = `if [ "$syntax" = bash ]; then block=${block(bashIntegration)}
else block=${block(zshIntegration)}; fi`
// The leading newline belongs to the block, so even files without a final newline round-trip exactly.
const bounds = `start=0; end=0
if [ -f "$rc" ]; then
  offsets=$(LC_ALL=C awk '
    $0=="${integrationStart}" { if (seen++) exit 1; first=n; inside=1; nextLine=NR+1 }
    NR==nextLine && $0 ~ /^# hopline original rc absent: [01]$/ { if (first>0) first-- }
    $0=="${integrationEnd}" { if (!inside) exit 1; last=n+length($0)+1; inside=0; closed=1 }
    { n+=length($0)+1 }
    END { if (inside || seen>1 || (seen && !closed)) exit 1; print first+0, last+0 }
  ' "$rc") || exit 1
  read start end <<EOF
$offsets
EOF
fi`
const strip = `if [ "$end" -gt 0 ]; then
  if [ "$start" -gt 0 ]; then head -c "$start" "$rc"; fi
  tail -c "+$((end + 1))" "$rc"
elif [ -f "$rc" ]; then cat "$rc"; fi`
const temporary = `tmp=$(mktemp "$rc.hopline-XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM`
const matches = `[ -f "$rc" ] && [ "$end" -gt 0 ] && [ "$(sed -n '/^${integrationStart}$/,/^${integrationEnd}$/p' "$rc")" = "$block" ]`

export const installShellIntegration: Runbook = {
  id: 'shell-integration-install', title: 'shellIntegration.install', steps: [{
    id: 'shell-integration-install', title: 'shellIntegration.install', description: 'shellIntegration.description', sudo: false,
    check: `${setup}\n${desired}\n${bounds}\n${matches} && exit 0; exit 10`,
    apply: `${setup}\n${desired}\n${bounds}\n${temporary}
if [ ! -e "$backup" ]; then
  if [ -f "$rc" ]; then cp -p "$rc" "$backup"; else (umask 077; set -C; : > "$backup"); fi
fi
{ ${strip}
printf '\\n%s\\n' "$block"; } > "$tmp"
"$syntax" -n "$tmp"
cat "$tmp" > "$rc"`,
    verify: `${setup}\n${desired}\n${bounds}\n${matches} && "$syntax" -n "$rc"`,
    rollback: `${setup}\n[ -f "$backup" ] || exit 1\nif [ "$absent" = 1 ]; then rm -f "$rc"; else cp -p "$backup" "$rc"; fi`
  }]
}
export const uninstallShellIntegration: Runbook = {
  id: 'shell-integration-uninstall', title: 'shellIntegration.uninstall', steps: [{
    id: 'shell-integration-uninstall', title: 'shellIntegration.uninstall', description: 'shellIntegration.backup', sudo: false,
    check: `${setup}\n${bounds}\n[ "$end" -eq 0 ] && exit 0; exit 10`,
    apply: `${setup}\n${bounds}\n${temporary}
{ ${strip}\n} > "$tmp"
cat "$tmp" > "$rc"
if [ -f "$backup" ]; then
  if cmp -s "$rc" "$backup"; then rm "$backup"; else echo 'shellIntegration.backupKept'; fi
fi
if [ "$absent" = 1 ] && [ ! -s "$rc" ]; then rm -f "$rc"; fi`,
    verify: `${setup}\n${bounds}\n[ "$end" -eq 0 ]`
  }]
}
