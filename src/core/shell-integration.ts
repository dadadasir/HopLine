const common = `
  __hopline_osc() {
    if [ -n "\${TMUX:-}" ]; then printf '\\033Ptmux;\\033\\033]%s\\007\\033\\\\' "$1"
    else printf '\\033]%s\\007' "$1"; fi
  }
  __hopline_url() {
    local LC_ALL=C value="$PWD" char byte encoded=''
    while [ -n "$value" ]; do
      char="\${value%"\${value#?}"}"; value="\${value#?}"
      case "$char" in [a-zA-Z0-9/._~-]) encoded="$encoded$char";;
        *) printf -v byte '%d' "'$char"; printf -v char '%%%02X' "$((byte & 255))"; encoded="$encoded$char";; esac
    done
    __hopline_osc "7;file://$__hopline_host$encoded"
  }
  __hopline_host=\${HOSTNAME:-\${HOST:-$(hostname 2>/dev/null)}}
`

export const bashIntegration = `if [ "\${HOPLINE_SHELL_INTEGRATION:-}" = 1 ] && [ -z "\${__hopline_loaded:-}" ]; then
  __hopline_loaded=1
${common}
  __hopline_capture() { __hopline_status=$?; return "$__hopline_status"; }
  __hopline_prompt() {
    __hopline_osc "133;D;$__hopline_status"
    __hopline_osc '133;A'
    __hopline_url
  }
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
    PROMPT_COMMAND=(__hopline_capture "\${PROMPT_COMMAND[@]}" __hopline_prompt)
  else PROMPT_COMMAND=$'__hopline_capture\\n'"\${PROMPT_COMMAND:-:}"$'\\n__hopline_prompt'; fi
  PS0="\${PS0:-}"'$(__hopline_osc "133;C")'
fi`

export const zshIntegration = `if [ "\${HOPLINE_SHELL_INTEGRATION:-}" = 1 ] && [ -z "\${__hopline_loaded:-}" ]; then
  __hopline_loaded=1
${common}
  __hopline_precmd() {
    local code=$?
    __hopline_osc "133;D;$code"
    __hopline_osc '133;A'
    __hopline_url
  }
  __hopline_preexec() { __hopline_osc '133;C'; }
  autoload -Uz add-zsh-hook
  # First in line, so $? is still the command's status rather than another hook's.
  add-zsh-hook precmd __hopline_precmd
  precmd_functions=(__hopline_precmd \${precmd_functions:#__hopline_precmd})
  add-zsh-hook preexec __hopline_preexec
fi`
