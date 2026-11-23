import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ATOMIC_EDIT_SCRIPT } from '../src/main/sftp/atomic-edit'

// This host is macOS and its Python lacks fd xattr APIs. File/rename/syscall
// behavior below is real; ONLY platform and xattr capabilities are substitutes.
// These tests are not Linux metadata/ACL integration evidence.
const shim = `
import os, sys, fcntl
fcntl.ioctl = lambda fd, request, buffer, mutate: 0
sys.platform = 'linux'
_xattrs = {}
def key(fd): return os.fstat(fd).st_ino
def getattrs(fd): return _xattrs.setdefault(key(fd), {})
os.listxattr = lambda fd: list(getattrs(fd))
os.getxattr = lambda fd, name: getattrs(fd)[name]
os.setxattr = lambda fd, name, value: getattrs(fd).__setitem__(name, value)
os.removexattr = lambda fd, name: getattrs(fd).__delitem__(name)
`
let root: string, target: string
const proof = { name: '.hopline-edit-probe-fixture', token: 'random-namespace-proof' }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-atomic-edit-')))
  target = path.join(root, 'file with quote\' and $name.txt')
  fs.writeFileSync(target, 'original', { mode: 0o640 })
  fs.writeFileSync(path.join(root, proof.name), proof.token, { mode: 0o600 })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function run(request: object, injection = '', supported = true): { ok: boolean; conflict?: boolean; baseline?: string; content?: string } {
  return JSON.parse(execFileSync('python3', ['-c', (supported ? shim : '') + injection + '\n' + ATOMIC_EDIT_SCRIPT], {
    input: JSON.stringify({ path: target, proof, ...request }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  }))
}
function read(injection = '') { const result = run({ op: 'read' }, injection); expect(result.ok).toBe(true); return result.baseline! }
function save(baseline: string, text = 'changed', injection = '') { return run({ op: 'save', baseline, content: Buffer.from(text).toString('base64') }, injection) }
function noTemporary() { expect(fs.readdirSync(root).filter(name => name.startsWith('.hopline-edit-') && name !== proof.name)).toEqual([]) }

it('probes before opening and atomically replaces complete contents while preserving ownership and mode', () => {
  const before = fs.statSync(target), baseline = read()
  expect(fs.readFileSync(target, 'utf8')).toBe('original'); noTemporary()
  const saved = save(baseline)
  expect(saved.ok).toBe(true)
  const after = fs.statSync(target)
  expect(after.ino).not.toBe(before.ino)
  expect([after.mode, after.uid, after.gid]).toEqual([before.mode, before.uid, before.gid])
  expect(fs.readFileSync(target, 'utf8')).toBe('changed')
  expect(save(saved.baseline!, 'second').ok).toBe(true)
  expect(fs.readFileSync(target, 'utf8')).toBe('second'); noTemporary()
})
it('rejects same-size same-second conflicts and metadata changes without overwriting', () => {
  const baseline = read(), before = fs.statSync(target)
  fs.writeFileSync(target, 'external'); fs.utimesSync(target, before.atime, before.mtime)
  expect(save(baseline)).toMatchObject({ ok: false, conflict: true })
  expect(fs.readFileSync(target, 'utf8')).toBe('external')
  const next = read(); fs.chmodSync(target, 0o600)
  expect(save(next)).toMatchObject({ ok: false, conflict: true }); noTemporary()
})
it.each(['symbolic', 'hard', 'directory'] as const)('refuses a %s link/path before editing', kind => {
  if (kind === 'symbolic') { fs.renameSync(target, path.join(root, 'actual')); fs.symlinkSync('actual', target) }
  else if (kind === 'hard') fs.linkSync(target, path.join(root, 'other'))
  else { fs.unlinkSync(target); fs.mkdirSync(target) }
  expect(run({ op: 'read' }).ok).toBe(false); noTemporary()
})
it('refuses symlink parents and mismatched namespace proofs', () => {
  fs.symlinkSync(root, path.join(root, 'parent'))
  expect(run({ op: 'read', path: path.join(root, 'parent', path.basename(target)) }).ok).toBe(false)
  expect(run({ op: 'read', proof: { ...proof, token: 'wrong' } }).ok).toBe(false)
  fs.unlinkSync(path.join(root, proof.name)); fs.symlinkSync(target, path.join(root, proof.name))
  expect(run({ op: 'read' }).ok).toBe(false)
})
it('keeps the original and cleans staging after metadata, write, or rename failure', () => {
  const baseline = read()
  for (const injection of [
    "os.fchmod = lambda *args: (_ for _ in ()).throw(OSError('denied'))",
    "os.write = lambda *args: (_ for _ in ()).throw(OSError('disk full'))",
    "os.replace = lambda *args, **kwargs: (_ for _ in ()).throw(OSError('unsupported'))"
  ]) {
    expect(save(baseline, 'changed', injection).ok).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('original'); noTemporary()
  }
})
it('preserves xattrs and fails closed when a server silently drops them (substitute)', () => {
  const attributes = `_xattrs[os.stat(${JSON.stringify('PLACEHOLDER')}).st_ino] = {'user.example': b'attribute'}\n`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(target))
  const baseline = read(attributes)
  expect(save(baseline, 'changed', attributes).ok).toBe(true)
  const next = read(attributes)
  expect(save(next, 'must not commit', attributes + 'os.setxattr = lambda *args: None\n').ok).toBe(false)
  expect(fs.readFileSync(target, 'utf8')).toBe('changed'); noTemporary()
})
it('detects a write after staging and before replacement', () => {
  const baseline = read()
  const inject = `
_real_fsync = os.fsync
def concurrent(fd):
    _real_fsync(fd)
    with open(${JSON.stringify(target)}, 'wb') as stream: stream.write(b'external')
os.fsync = concurrent
`
  expect(save(baseline, 'changed', inject)).toMatchObject({ ok: false, conflict: true })
  expect(fs.readFileSync(target, 'utf8')).toBe('external'); noTemporary()
})
it('rejects unavailable platform/xattr support without creating files', () => {
  expect(run({ op: 'read' }, "import sys\nsys.platform = 'unsupported'", false).ok).toBe(false)
  expect(fs.readFileSync(target, 'utf8')).toBe('original'); noTemporary()
})
it('rejects oversized original files before reading or staging', () => {
  fs.truncateSync(target, 20 * 1024 * 1024 + 1)
  expect(run({ op: 'read' }).ok).toBe(false); noTemporary()
})

it('rejects inode flags that replacement cannot preserve and unavailable flag APIs (substitute)', () => {
  for (const injection of [
    "fcntl.ioctl = lambda fd, request, buffer, mutate: buffer.__setitem__(0, 0x40)",
    "fcntl.ioctl = lambda *args: (_ for _ in ()).throw(OSError('unsupported'))"
  ]) {
    expect(run({ op: 'read' }, injection).ok).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('original'); noTemporary()
  }
})
it('treats deletion as a conflict and leaves no staged files', () => {
  const baseline = read(); fs.unlinkSync(target)
  expect(save(baseline)).toMatchObject({ ok: false, conflict: true }); noTemporary()
})
it('cleans a partial stage on termination without changing the original', () => {
  const baseline = read()
  const injection = `
import signal
_write = os.write
def partial(fd, data):
    _write(fd, data[:2])
    signal.raise_signal(signal.SIGTERM)
os.write = partial
`
  expect(save(baseline, 'changed', injection).ok).toBe(false)
  expect(fs.readFileSync(target, 'utf8')).toBe('original'); noTemporary()
})
it('refuses a substituted staging path without deleting the substituted file', () => {
  const baseline = read()
  const injection = `
_fsync = os.fsync
def substitute(fd):
    _fsync(fd)
    for name in os.listdir(${JSON.stringify(root)}):
        if name.startswith('.hopline-edit-') and not name.startswith('.hopline-edit-probe-'):
            filename = os.path.join(${JSON.stringify(root)}, name)
            os.unlink(filename)
            with open(filename, 'wb') as stream: stream.write(b'foreign')
os.fsync = substitute
`
  expect(save(baseline, 'changed', injection).ok).toBe(false)
  expect(fs.readFileSync(target, 'utf8')).toBe('original')
  const remaining = fs.readdirSync(root).filter(name => name.startsWith('.hopline-edit-') && name !== proof.name)
  expect(remaining).toHaveLength(1)
  expect(fs.readFileSync(path.join(root, remaining[0]), 'utf8')).toBe('foreign')
})
it('does not report success when another writer changes the file after rename', () => {
  const baseline = read()
  const injection = `
_replace = os.replace
def write_after(*args, **kwargs):
    _replace(*args, **kwargs)
    with open(${JSON.stringify(target)}, 'wb') as stream: stream.write(b'external')
os.replace = write_after
`
  expect(save(baseline, 'changed', injection)).toMatchObject({ ok: false, conflict: true })
  expect(fs.readFileSync(target, 'utf8')).toBe('external'); noTemporary()
})

it.each(['security.ima', 'security.evm'])('refuses content-bound integrity metadata %s (substitute)', name => {
  const injection = `_xattrs[os.stat(${JSON.stringify(target)}).st_ino] = {${JSON.stringify(name)}: b'signature'}`
  expect(run({ op: 'read' }, injection).ok).toBe(false)
  expect(fs.readFileSync(target, 'utf8')).toBe('original'); noTemporary()
})
