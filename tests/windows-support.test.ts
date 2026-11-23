import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_OPENSSH_PIPE,
  defaultAgentSocket,
  expandLocalPath,
  isVirtualAgentTarget,
  isWindowsNamedPipe,
  isWindowsPath,
  normalizeWindowsPipe,
  renameReplaceAsync,
  renameReplaceSync,
  resolveAsarUnpackedModule,
  resolveAsarUnpackedPath,
  resolveWindowsShell,
  safeChmodSync
} from '../src/core/win-platform'
import { parseSshConfig } from '../src/core/ssh-config'
import { connectEndpoint } from '../src/main/ssh/connect'
import { translate } from '../src/renderer/src/i18n'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml')

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-win-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Windows platform core utilities', () => {
  it('detects Windows drive paths, UNC paths, named pipes, and virtual SSH agent targets', () => {
    expect(isWindowsPath('C:\\Users\\hop\\.ssh\\id_ed25519')).toBe(true)
    expect(isWindowsPath('D:/keys/prod.pem')).toBe(true)
    expect(isWindowsPath(WINDOWS_OPENSSH_PIPE)).toBe(true)
    expect(isWindowsPath('/Users/hop/.ssh/id_ed25519')).toBe(false)

    expect(isWindowsNamedPipe('\\\\.\\pipe\\openssh-ssh-agent')).toBe(true)
    expect(isWindowsNamedPipe('//./pipe/openssh-ssh-agent')).toBe(true)
    expect(normalizeWindowsPipe('//./pipe/openssh-ssh-agent')).toBe('\\\\.\\pipe\\openssh-ssh-agent')

    expect(isVirtualAgentTarget(WINDOWS_OPENSSH_PIPE, 'win32')).toBe(true)
    expect(isVirtualAgentTarget('pageant', 'win32')).toBe(true)
    expect(isVirtualAgentTarget('PAGEANT', 'win32')).toBe(true)
    expect(isVirtualAgentTarget('pageant', 'darwin')).toBe(false)
  })

  it('defaults SSH agent socket to Windows OpenSSH named pipe only when SSH_AUTH_SOCK is unset', () => {
    expect(defaultAgentSocket('win32', {})).toBe(WINDOWS_OPENSSH_PIPE)
    expect(defaultAgentSocket('win32', { SSH_AUTH_SOCK: '\\\\.\\pipe\\custom-agent' })).toBe('\\\\.\\pipe\\custom-agent')
    expect(defaultAgentSocket('win32', { SSH_AUTH_SOCK: '' })).toBe('')
    expect(defaultAgentSocket('darwin', {})).toBeUndefined()
  })

  it('expands ~, ~\\, %USERPROFILE%, %LOCALAPPDATA%, Pageant, and named pipes on Windows', () => {
    const env = {
      USERPROFILE: 'C:\\Users\\hop',
      LOCALAPPDATA: 'C:\\Users\\hop\\AppData\\Local',
      APPDATA: 'C:\\Users\\hop\\AppData\\Roaming'
    }
    expect(expandLocalPath('~\\.ssh\\id_ed25519', 'C:\\Users\\hop', env, 'win32')).toBe('C:\\Users\\hop\\.ssh\\id_ed25519')
    expect(expandLocalPath('~/.ssh/id_ed25519', 'C:\\Users\\hop', env, 'win32')).toBe('C:\\Users\\hop\\.ssh\\id_ed25519')
    expect(expandLocalPath('%USERPROFILE%\\.ssh\\work_ed25519', 'C:\\Users\\hop', env, 'win32')).toBe('C:\\Users\\hop\\.ssh\\work_ed25519')
    expect(expandLocalPath('%LOCALAPPDATA%\\Key\\id_rsa', 'C:\\Users\\hop', env, 'win32')).toBe('C:\\Users\\hop\\AppData\\Local\\Key\\id_rsa')
    expect(expandLocalPath('Pageant', 'C:\\Users\\hop', env, 'win32')).toBe('pageant')
    expect(expandLocalPath('//./pipe/openssh-ssh-agent', 'C:\\Users\\hop', env, 'win32')).toBe(WINDOWS_OPENSSH_PIPE)
  })

  it('selects PowerShell 7 -> Windows PowerShell -> cmd.exe in priority order', () => {
    const pwshPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    const winPsPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsShell({ HOPLINE_SHELL: 'D:\\Tools\\nu.exe' }, () => false)
    ).toEqual({ file: 'D:\\Tools\\nu.exe', args: [] })

    expect(
      resolveWindowsShell(
        { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
        (candidate) => candidate === pwshPath || candidate === winPsPath
      )
    ).toEqual({ file: pwshPath, args: ['-NoLogo'] })

    expect(
      resolveWindowsShell(
        { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
        (candidate) => candidate === winPsPath
      )
    ).toEqual({ file: winPsPath, args: ['-NoLogo'] })

    expect(
      resolveWindowsShell({ COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, () => false)
    ).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [] })
  })

  it('retries transient EPERM/EACCES/EBUSY atomic renames on win32 without masking fatal errors', async () => {
    let attempts = 0
    renameReplaceSync('a.tmp', 'a.json', 'win32', () => {
      attempts++
      if (attempts < 3) {
        const err = Object.assign(new Error('locked by defender'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' })
        throw err
      }
    })
    expect(attempts).toBe(3)

    let asyncAttempts = 0
    await renameReplaceAsync('a.part', 'a.bin', 'win32', async () => {
      asyncAttempts++
      if (asyncAttempts < 3) {
        throw Object.assign(new Error('locked by indexer'), { code: asyncAttempts === 1 ? 'EACCES' : 'EBUSY' })
      }
    })
    expect(asyncAttempts).toBe(3)

    let posixAttempts = 0
    expect(() =>
      renameReplaceSync('a.tmp', 'a.json', 'darwin', () => {
        posixAttempts++
        throw Object.assign(new Error('denied'), { code: 'EPERM' })
      })
    ).toThrow('denied')
    expect(posixAttempts).toBe(1)

    const dir = makeTempDir()
    const file = path.join(dir, 'sample.json')
    fs.writeFileSync(file, '{}')
    expect(() => safeChmodSync(file, 0o600, 'win32')).not.toThrow()
  })

  it('rewrites unpacked native modules and helper binaries while keeping ssh2 inside app.asar with its dependencies', () => {
    const winCaller = 'E:\\Hopline\\resources\\app.asar\\out\\main\\index.js'
    const resolvedPty = resolveAsarUnpackedModule(
      'node-pty',
      winCaller,
      (candidate) => candidate === 'E:\\Hopline\\resources\\app.asar.unpacked\\node_modules\\node-pty\\package.json'
    )
    expect(resolvedPty).toBe('E:\\Hopline\\resources\\app.asar.unpacked\\node_modules\\node-pty')

    const pagentInAsar = 'E:\\Hopline\\resources\\app.asar\\node_modules\\ssh2\\util\\pagent.exe'
    const pagentUnpacked = 'E:\\Hopline\\resources\\app.asar.unpacked\\node_modules\\ssh2\\util\\pagent.exe'
    expect(resolveAsarUnpackedPath(pagentInAsar, (candidate) => candidate === pagentUnpacked)).toBe(pagentUnpacked)
    expect(resolveAsarUnpackedPath(pagentInAsar, () => false)).toBe(pagentInAsar)
    expect(resolveAsarUnpackedModule('node-pty', '/Users/hop/dev/Hopline/out/main/index.js')).toBe('node-pty')

    // Regression for Windows real-machine crash: loading ssh2 from app.asar.unpacked
    // breaks CommonJS lookup of asn1 / safer-buffer / bcrypt-pbkdf / tweetnacl inside app.asar.
    for (const file of ['src/main/ssh/connect.ts', 'src/main/init-gates.ts']) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source).not.toContain('resolveAsarUnpackedModule')
    }

    const builder = load(fs.readFileSync('electron-builder.yml', 'utf8')) as {
      win: { asarUnpack: string[] }
    }
    expect(builder.win.asarUnpack).toContain('**/node_modules/ssh2/util/pagent.exe')
    expect(builder.win.asarUnpack).not.toContain('**/node_modules/ssh2/**')
    expect(builder.win.asarUnpack).toContain('**/node_modules/node-pty/**')

    // Verify unpacked node-pty runtime files never require external npm packages from app.asar.
    const builtins = new Set(require('node:module').builtinModules)
    const scanPtyDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) scanPtyDir(full)
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
          const code = fs.readFileSync(full, 'utf8')
          for (const match of code.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
            const spec = match[2]!
            const allowed = spec.startsWith('.') || builtins.has(spec) || builtins.has(spec.replace(/^node:/, ''))
            expect(allowed, `unexpected external require('${spec}') in ${full}`).toBe(true)
          }
        }
      }
    }
    scanPtyDir(path.resolve('node_modules/node-pty/lib'))
  })
})

describe('Windows ssh_config parsing and SSH agent targets', () => {
  it('preserves Windows drive letters, backslashes, quoted paths, named pipes, and Pageant in ssh_config', () => {
    const winHome = 'C:\\Users\\hop'
    const files = new Map<string, string>([
      [
        'C:\\Users\\hop\\.ssh\\config',
        [
          'Include conf.d\\*.conf',
          '',
          'Host prod-win',
          '  HostName 10.20.30.40',
          '  User ubuntu',
          '  IdentityFile C:\\Users\\hop\\.ssh\\id_ed25519',
          '  IdentityAgent \\\\\\\\.\\pipe\\openssh-ssh-agent',
          '',
          'Host pageant-box',
          '  HostName 10.20.30.41',
          '  User debian',
          '  IdentityFile "C:\\Users\\Hop User\\.ssh\\my key"',
          '  IdentityAgent pageant'
        ].join('\n')
      ],
      [
        'C:\\Users\\hop\\.ssh\\conf.d\\extra.conf',
        [
          'Host included-win',
          '  HostName 10.20.30.42',
          '  User admin',
          '  IdentityFile ~\\.ssh\\work_key'
        ].join('\n')
      ],
      [
        'C:\\Users\\hop\\.ssh\\id_ed25519',
        'PRIVATE_KEY'
      ],
      [
        'C:\\Users\\hop\\.ssh\\id_ed25519.pub',
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@win'
      ],
      [
        'C:\\Users\\Hop User\\.ssh\\my key.pub',
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI pageant@win'
      ],
      [
        'C:\\Users\\hop\\.ssh\\work_key',
        'WORK_PRIVATE_KEY'
      ]
    ])

    const reader = Object.assign(
      (file: string) => files.get(file) ?? null,
      {
        glob: (pattern: string) =>
          pattern === 'C:\\Users\\hop\\.ssh\\conf.d\\*.conf'
            ? ['C:\\Users\\hop\\.ssh\\conf.d\\extra.conf']
            : []
      }
    )

    const parsed = parseSshConfig('C:\\Users\\hop\\.ssh\\config', reader, winHome)

    expect(parsed.warnings).toEqual([])
    const byName = Object.fromEntries(parsed.hosts.map((host) => [host.name, host]))

    expect(byName['prod-win']).toMatchObject({
      host: '10.20.30.40',
      username: 'ubuntu',
      authType: 'agent',
      privateKeyPath: null,
      agent: {
        socket: '\\\\.\\pipe\\openssh-ssh-agent',
        identityFile: 'C:\\Users\\hop\\.ssh\\id_ed25519.pub',
        forward: false
      }
    })

    expect(byName['pageant-box']).toMatchObject({
      host: '10.20.30.41',
      username: 'debian',
      authType: 'agent',
      privateKeyPath: null,
      agent: {
        socket: 'pageant',
        identityFile: 'C:\\Users\\Hop User\\.ssh\\my key.pub',
        forward: false
      }
    })

    expect(byName['included-win']).toMatchObject({
      host: '10.20.30.42',
      username: 'admin',
      authType: 'privateKey',
      privateKeyPath: 'C:\\Users\\hop\\.ssh\\work_key'
    })
  })

  it('accepts Windows named pipe agent targets without rejecting them via fs.existsSync', async () => {
    // Pass a closed local TCP port so connectEndpoint builds ConnectConfig (validating agent socket)
    // and fails at TCP connect rather than falsely throwing "agent socket 不存在".
    await expect(
      connectEndpoint(
        {
          host: '127.0.0.1',
          port: 1,
          username: 'ubuntu',
          connectionTimeoutSec: 5,
          auth: {
            authType: 'agent',
            password: null,
            privateKey: null,
            privateKeyPath: null,
            passphrase: null,
            agent: { socket: WINDOWS_OPENSSH_PIPE, identityFile: null, forward: false }
          }
        },
        {
          verifyHost: async () => true,
          onKeyboard: async () => null
        }
      )
    ).rejects.not.toThrow(/agent socket 不存在/)
  })
})

describe('Windows icon and UI localization', () => {
  it('ships a valid multi-resolution ICO file including a 256x256 frame for NSIS and Explorer', () => {
    const ico = fs.readFileSync(path.resolve('build/win/icon.ico'))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1) // ICO type = 1
    const count = ico.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(6)
    const widths: number[] = []
    for (let i = 0; i < count; i++) {
      const widthByte = ico.readUInt8(6 + i * 16)
      widths.push(widthByte === 0 ? 256 : widthByte)
    }
    expect(widths).toEqual(expect.arrayContaining([16, 32, 48, 256]))
  })

  it('provides complete Chinese and English labels for Windows caption controls and SSH agents', () => {
    expect(translate('zh', 'window.restore')).toBe('向下还原')
    expect(translate('en', 'window.restore')).toBe('Restore')
    expect(translate('zh', 'agent.systemWin')).toContain('OpenSSH')
    expect(translate('en', 'agent.systemWin')).toContain('OpenSSH')
    expect(translate('zh', 'agent.pageant')).toBe('PuTTY Pageant')
    expect(translate('en', 'agent.pageant')).toBe('PuTTY Pageant')
  })
})
