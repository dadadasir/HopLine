import { randomBytes } from 'node:crypto'
import type { ConnectionPool } from './pool'
import { execOnClient, type ExecOptions, type ExecResult } from './exec'
import { shellEscape } from '../../core/shell'

export interface ReadOnlyExecOptions extends Omit<ExecOptions, 'stdin' | 'onStdout'> {
  /** A single input line for permission probes; mutually exclusive with outer sudo. */
  stdin?: string
  /** The raw script is elevated outside its isolated process group. Never nest sudo. */
  sudo?: { mode: 'root' | 'nopass' | 'password'; password?: string }
}

const aborted = () => Object.assign(new Error('cleanup.readOnlyCanceled'), { name: 'AbortError' })
const clean = (text: string, secrets: string[]) => {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('***')
  return text
}

/** No remote control files: PID and start time are handed back on this command's stdout. */
function supervised(script: string, marker: string, timeoutMs: number, hasInput: boolean): string {
  const supervisor = `set -eu
export LC_ALL=C
leader=$$
# /proc/stat comm may contain spaces and parentheses: strip through its final ') '.
identity=$(cat /proc/$$/stat) || exit 125
identity=\${identity##*) }
set -- $identity
[ "$3" = "$$" ] && [ "$4" = "$$" ] || exit 125
start=\${20}
case "$start" in ''|*[!0-9]*) exit 125 ;; esac
stop() {
  # Keep this group leader alive until KILL, preventing process-group ID reuse.
  trap '' TERM HUP INT
  kill -TERM -"$leader" 2>/dev/null || :
  sleep 1
  kill -KILL -"$leader"
}
trap stop TERM HUP INT
printf '${marker} %s %s\\n' "$leader" "$start"
# A bounded remote watchdog also cleans up after the client loses its connection.
(
  sleep ${Math.max(1, Math.ceil(timeoutMs / 1000))} & sleeper=$!
  trap 'kill "$sleeper" 2>/dev/null || :; wait "$sleeper" 2>/dev/null || :; exit 0' TERM HUP INT
  wait "$sleeper" && kill -TERM "$leader"
) </dev/null >/dev/null 2>&1 & watchdog=$!
set +e
sh -c ${shellEscape(script)} ${hasInput ? '<&3 3<&-' : '</dev/null'} & worker=$!
${hasInput ? 'exec 3<&-' : ''}
wait "$worker"
code=$?
# Return the payload exit code before destroying this group (including the watchdog).
printf '\n${marker} done %s\\n' "$code"
kill -KILL -"$leader"`
  return `set -eu\nexport LC_ALL=C\ncommand -v setsid >/dev/null 2>&1 && [ -r /proc/self/stat ] || { printf '${marker} unavailable\\n'; exit 125; }\n${hasInput ? 'exec 3<&0\n' : ''}setsid sh -c ${shellEscape(supervisor)} ${shellEscape(marker)} ${hasInput ? '<&3' : ''} & child=$!\n${hasInput ? 'exec 3<&-\n' : ''}wait "$child" 2>/dev/null`
}

function stopCommand(pid: number, started: string, marker: string): string {
  return `set -eu
export LC_ALL=C
[ -r /proc/${pid}/stat ] || exit 0
identity=$(cat /proc/${pid}/stat) || exit 0
identity=\${identity##*) }
set -- $identity
[ "$3" = '${pid}' ] && [ "$4" = '${pid}' ] && [ "\${20}" = '${started}' ] || exit 125
tr '\\000' '\\n' < /proc/${pid}/cmdline | grep -Fxq ${shellEscape(marker)} || exit 125
kill -TERM ${pid} || [ ! -r /proc/${pid}/stat ]`
}

/** A negative PGID probe detects inaccessible members too; never signal during verification. */
function goneCommand(pid: number): string {
  return `set -eu
export LC_ALL=C
for attempt in 1 2 3; do
  if message=$(kill -0 -${pid} 2>&1); then :
  else
    case "$message" in *'No such process'*) exit 0 ;; esac
  fi
  sleep 1
done
exit 125`
}

/**
 * Only for bounded read-only commands. The caller must never use this for apply/verify.
 * Cancellation waits for the isolated group to exit; closing a channel alone is not success.
 * Privileged payload output is internal/raw: callers must parse measurements first,
 * then redact strings before IPC or logging. Numeric passwords must not alter bytes.
 */
export async function execReadOnly(pool: Pick<ConnectionPool, 'acquire'>, hostId: string, script: string, options: ReadOnlyExecOptions = {}): Promise<ExecResult> {
  if (options.signal?.aborted) throw aborted()
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('cleanup.readOnlyUnavailable')
  const marker = `hopline-readonly-${randomBytes(18).toString('hex')}`
  if (options.sudo && options.stdin !== undefined) throw new Error('cleanup.readOnlyUnavailable')
  let password = options.sudo?.password
  let probeInput = options.stdin
  const inputSecret = probeInput?.replace(/\n$/, '') ?? ''
  if (/[\r\n\0]/.test(inputSecret)) throw new Error('cleanup.readOnlyUnavailable')
  const secrets = [password ?? '', inputSecret]
  const elevated = options.sudo && options.sudo.mode !== 'root'
  if (options.sudo?.mode === 'password' && (!password || /[\r\n\0]/.test(password))) throw new Error('sudo 密码不正确')
  const wrap = (command: string) => elevated ? `sudo -S -p '' sh -c ${shellEscape(command)}` : command
  const controlInput = () => options.sudo?.mode === 'password' ? `${password}\n` : undefined
  const input = () => controlInput() ?? probeInput
  const lease = await pool.acquire(hostId, { signal: options.signal })
  const emergency = new AbortController()
  let header = '', tail = '', completedCode: number | undefined, identity: { pid: number; started: string } | undefined, unavailable = false
  let stopped = false, timedOut = false, failedStop = false, settled = false
  let stopping: Promise<void> | undefined, grace: NodeJS.Timeout | undefined
  const stop = () => {
    stopped = true
    if (stopping || settled || !identity) return
    const target = identity
    // A failed control channel is reported as unconfirmed, never as successful cancellation.
    grace = setTimeout(() => { failedStop = true; emergency.abort() }, 10_000)
    stopping = (async () => {
      try {
        const result = await execOnClient(lease.client, wrap(stopCommand(target.pid, target.started, marker)), { stdin: controlInput(), timeoutMs: 5_000, maxOutputBytes: 1024 })
        if (result.code !== 0 || result.timedOut || result.signal) { failedStop = true; emergency.abort() }
      } catch { failedStop = true; emergency.abort() }
    })()
  }
  const abort = () => stop()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  // Before the handshake no business command has started; bound broken transports too.
  const startup = setTimeout(() => { if (!identity) { failedStop = true; emergency.abort() } }, Math.min(timeoutMs + 10_000, 40_000))
  try {
    options.beforeStart?.()
    if (options.signal?.aborted) stop()
    const result = await execOnClient(lease.client, wrap(supervised(script, marker, timeoutMs + 2_000, probeInput !== undefined)), {
      stdin: input(), signal: emergency.signal, timeoutMs: 0, maxOutputBytes: (options.maxOutputBytes ?? 4 * 1024 * 1024) + 320,
      onStdout: (chunk) => {
        tail = (tail + chunk.toString('utf8')).slice(-1024)
        const completed = new RegExp(`\\n${marker} done (\\d+)\\r?\\n`).exec(tail)
        if (completed) completedCode = Number(completed[1])
        if (identity || unavailable) return
        header = (header + chunk.toString('utf8')).slice(0, 1024)
        const match = new RegExp(`(?:^|\\n)${marker} (\\d+) (\\d+)\\r?\\n`).exec(header)
        if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 1) {
          identity = { pid: Number(match[1]), started: match[2] }
          clearTimeout(startup)
          if (stopped) stop()
        } else if (header.includes(`${marker} unavailable\n`)) unavailable = true
      }
    })
    settled = true
    await stopping
    if (failedStop) throw new Error('cleanup.cancelUnconfirmed')
    if (stopped && identity) {
      // The supervisor cannot kill a root PAM helper whose real UID changed.
      // Only ESRCH proves the entire group is gone; EPERM and unknown responses do not.
      const gone = await execOnClient(lease.client, wrap(goneCommand(identity.pid)), { stdin: controlInput(), timeoutMs: 5_000, maxOutputBytes: 1024 }).catch(() => null)
      if (!gone || gone.code !== 0 || gone.timedOut || gone.signal) throw new Error('cleanup.cancelUnconfirmed')
    }
    if (stopped && !identity && !unavailable) throw new Error('cleanup.cancelUnconfirmed')
    if (options.signal?.aborted) throw aborted()
    if (unavailable || !identity && result.code === 125) throw new Error('cleanup.readOnlyUnavailable')
    const stdout = result.stdout.replace(new RegExp(`(?:^|\\n)${marker} \\d+ \\d+\\r?\\n`), '').replace(new RegExp(`\\n${marker} done \\d+\\r?\\n`), '')
    const limit = Math.max(0, options.maxOutputBytes ?? 4 * 1024 * 1024)
    const resultSecrets = probeInput !== undefined ? [inputSecret] : []
    const out = Buffer.from(clean(stdout, resultSecrets)), err = Buffer.from(clean(result.stderr, resultSecrets))
    return { ...result, ...(completedCode !== undefined ? { code: completedCode, signal: null } : {}), stdout: out.subarray(0, limit).toString('utf8'), stderr: err.subarray(0, Math.max(0, limit - out.length)).toString('utf8'), truncated: result.truncated || out.length + err.length > limit, timedOut: timedOut || result.timedOut }
  } catch (error) {
    if (failedStop) throw new Error('cleanup.cancelUnconfirmed')
    if (error instanceof Error && error.message === 'runbook.targetChanged') throw new Error('runbook.targetChanged')
    const safe = new Error(clean(error instanceof Error ? error.message : 'cleanup.readOnlyUnavailable', secrets))
    if (error instanceof Error && error.name === 'AbortError') safe.name = 'AbortError'
    throw safe
  } finally {
    settled = true
    clearTimeout(timer); clearTimeout(startup); clearTimeout(grace)
    options.signal?.removeEventListener('abort', abort)
    password = undefined; probeInput = undefined; secrets.fill('')
    lease.release()
  }
}
