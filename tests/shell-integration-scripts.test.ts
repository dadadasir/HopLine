import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { bashIntegration, zshIntegration } from '../src/core/shell-integration'
import { shellEscape } from '../src/core/shell'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-shell-')) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
const hasZsh = spawnSync('zsh', ['--version']).status === 0
for (const [shell, script] of [['bash', bashIntegration], ['zsh', zshIntegration]]) {
  it.skipIf(shell === 'zsh' && !hasZsh)(`${shell}: syntax, opt-in, hooks, encoding and tmux wrapping`, () => {
    expect(spawnSync(shell, ['-n'], { input: script, encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' })
    const file = path.join(directory, 'integration.sh'); fs.writeFileSync(file, script)
    const cwd = path.join(directory, "spaces #%;'中文"); fs.mkdirSync(cwd)
    const exec = (body: string, enabled = false) => spawnSync(shell, ['-c', body], {
      encoding: 'utf8', cwd, env: { ...process.env, HOME: directory, HOPLINE_SHELL_INTEGRATION: enabled ? '1' : '', TMUX: '' }
    })
    expect(exec(`. ${shellEscape(file)}`)).toMatchObject({ status: 0, stdout: '', stderr: '' })
    const hook = shell === 'bash' ? 'false; eval "$PROMPT_COMMAND"; eval "printf %s \\"$PS0\\""' : 'false; __hopline_precmd; __hopline_preexec'
    const result = exec(`PROMPT_COMMAND='printf old-hook'; . ${shellEscape(file)}; . ${shellEscape(file)}; ${hook}`, true)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('\x1b]133;D;1\x07')
    expect(result.stdout).toContain('\x1b]133;A\x07')
    expect(result.stdout).toContain('\x1b]133;C\x07')
    expect(result.stdout).toContain(`/spaces%20%23%25%3B%27%E4%B8%AD%E6%96%87\x07`)
    expect(result.stdout.match(/133;A/g)).toHaveLength(1)
    if (shell === 'bash') expect(result.stdout).toContain('old-hook')
    else {
      const hooks = exec(`precmd_functions=(existing); preexec_functions=(existing); . ${shellEscape(file)}; print -l $precmd_functions $preexec_functions`, true)
      expect(hooks.stdout).toBe('__hopline_precmd\nexisting\nexisting\n__hopline_preexec\n')
    }
    expect(exec(`. ${shellEscape(file)}; TMUX=test; __hopline_osc '133;C'`, true).stdout).toBe('\x1bPtmux;\x1b\x1b]133;C\x07\x1b\\')
  })
}
it('bash: preserves array prompt hooks and captures status before they change it', () => {
  const file = path.join(directory, 'bash.sh'); fs.writeFileSync(file, bashIntegration)
  const result = spawnSync('bash', ['-c', `PROMPT_COMMAND=('printf first' 'printf second'); . ${shellEscape(file)}; false; __hopline_capture; eval "\${PROMPT_COMMAND[1]}"; eval "\${PROMPT_COMMAND[2]}"; __hopline_prompt`], {
    encoding: 'utf8', env: { ...process.env, HOPLINE_SHELL_INTEGRATION: '1', TMUX: '' }
  })
  expect(result.stdout).toContain('firstsecond\x1b]133;D;1\x07')
})
it('bash: interactive prompt cycles report cd and failure without changing existing hooks', () => {
  const file = path.join(directory, 'bash.sh'); fs.writeFileSync(file, bashIntegration)
  const result = spawnSync('bash', ['--noprofile', '--norc', '-i'], {
    input: `PROMPT_COMMAND='printf existing'; . ${shellEscape(file)}\ncd /tmp\nfalse\nexit\n`, encoding: 'utf8',
    env: { ...process.env, HOPLINE_SHELL_INTEGRATION: '1', HOME: directory, PS1: '$ ', TMUX: '' }
  })
  expect(result.stdout).toContain('existing\x1b]133;D;1\x07')
  expect(result.stdout).toContain('/tmp\x07')
})
