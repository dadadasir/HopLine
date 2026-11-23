import type { Client } from 'ssh2'
import { shellEscape } from '../../core/shell'
import { execOnClient } from '../ssh/exec'
import { EDIT_LIMIT } from './edit-content'

export interface EditNamespaceProof { name: string; token: string }

// All paths/data arrive on stdin. Directory descriptors anchor every operation;
// no shell path interpolation or fallback to truncating the original is allowed.
export const ATOMIC_EDIT_SCRIPT = String.raw`
import os, sys, stat, json, hashlib, base64, secrets, signal, fcntl, array
LIMIT = 20 * 1024 * 1024
class Refused(Exception): pass
class Conflict(Exception): pass
def interrupted(signum, frame): raise Refused('interrupted')
for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM): signal.signal(sig, interrupted)
def digest(data): return hashlib.sha256(data).hexdigest()
def attrs(fd):
    return {name: base64.b64encode(os.getxattr(fd, name)).decode('ascii') for name in sorted(os.listxattr(fd))}
def flags(fd):
    value = array.array('l', [0])
    fcntl.ioctl(fd, 0x80086601, value, True)
    if value[0] & ~0x80000: raise Refused('unsupported inode flags')
def remove_owned(parent, name, fd):
    try:
        actual = os.stat(name, dir_fd=parent, follow_symlinks=False); expected = os.fstat(fd)
        if (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino): os.unlink(name, dir_fd=parent)
    except FileNotFoundError: pass
def identity(s):
    return [s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns]
def regular(s):
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1: raise Refused('links or non-regular file')
    if s.st_size > LIMIT: raise Refused('size')
def read_revision(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd); regular(before); flags(fd)
        metadata = attrs(fd)
        if any(name in metadata for name in ('security.ima', 'security.evm')): raise Refused('content-bound integrity metadata')
        chunks = []; size = 0
        while True:
            chunk = os.read(fd, min(65536, LIMIT + 1 - size))
            if not chunk: break
            chunks.append(chunk); size += len(chunk)
            if size > LIMIT: raise Refused('size')
        data = b''.join(chunks)
        after = os.fstat(fd)
        if identity(before) != identity(after) or metadata != attrs(fd) or identity(after) != identity(os.stat(name, dir_fd=parent, follow_symlinks=False)):
            raise Conflict('changed while reading')
        value = {'stat': identity(after), 'attrs': metadata, 'digest': digest(data)}
        token = digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())
        return data, after, metadata, token
    finally: os.close(fd)
def stage(parent, data, original, metadata):
    name = '.hopline-edit-' + secrets.token_hex(24)
    fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0: raise Refused('short write')
            offset += count
        current = os.fstat(fd)
        if (current.st_uid, current.st_gid) != (original.st_uid, original.st_gid): os.fchown(fd, original.st_uid, original.st_gid)
        os.fchmod(fd, stat.S_IMODE(original.st_mode))
        for key in os.listxattr(fd):
            if key not in metadata: os.removexattr(fd, key)
        for key, value in metadata.items(): os.setxattr(fd, key, base64.b64decode(value, validate=True))
        actual = os.fstat(fd); flags(fd)
        if (actual.st_uid, actual.st_gid, stat.S_IMODE(actual.st_mode), actual.st_nlink) != (original.st_uid, original.st_gid, stat.S_IMODE(original.st_mode), 1) or attrs(fd) != metadata:
            raise Refused('metadata cannot be preserved')
        os.fsync(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        check = b''
        while len(check) <= LIMIT:
            block = os.read(fd, min(65536, LIMIT + 1 - len(check)))
            if not block: break
            check += block
        if check != data: raise Refused('staged content mismatch')
        return name, fd
    except BaseException:
        try: remove_owned(parent, name, fd)
        finally: os.close(fd)
        raise

def run(request):
    if sys.platform != 'linux' or not all(hasattr(os, name) for name in ('listxattr','getxattr','setxattr','removexattr','O_NOFOLLOW','O_DIRECTORY')):
        raise Refused('unsupported platform')
    target = request['path']
    if not isinstance(target, str) or not target.startswith('/') or '\x00' in target: raise Refused('path')
    pieces = target.split('/')[1:]
    if not pieces or any(part in ('', '.', '..') for part in pieces): raise Refused('path')
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None; staged_fd = None
    try:
        for part in pieces[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = next_fd
        proof = request['proof']; proof_name = proof['name']; proof_token = proof['token']
        if not isinstance(proof_name, str) or not proof_name.startswith('.hopline-edit-probe-') or '/' in proof_name or '\x00' in proof_name or not isinstance(proof_token, str) or len(proof_token) > 256:
            raise Refused('namespace proof')
        proof_fd = os.open(proof_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            regular(os.fstat(proof_fd))
            if os.read(proof_fd, 257) != proof_token.encode('ascii'): raise Refused('namespace mismatch')
        finally: os.close(proof_fd)
        try:
            data, original, metadata, baseline = read_revision(parent, pieces[-1])
        except (FileNotFoundError, Refused):
            if request['op'] == 'save': raise Conflict('target unavailable or replaced')
            raise
        if request['op'] == 'save':
            if request['baseline'] != baseline: raise Conflict('baseline changed')
            data = base64.b64decode(request['content'], validate=True)
            if len(data) > LIMIT: raise Refused('size')
        elif request['op'] != 'read': raise Refused('operation')
        # Opening an editor also probes actual replacement/metadata capability.
        temporary, staged_fd = stage(parent, data, original, metadata)
        try: _, _, _, latest = read_revision(parent, pieces[-1])
        except (FileNotFoundError, Refused): raise Conflict('target unavailable or replaced')
        if latest != baseline: raise Conflict('changed before replacement')
        if request['op'] == 'save':
            # This is atomic for file completeness, not compare-and-swap against
            # unrelated writers in the final check-to-rename interval.
            staged_data, staged_stat, staged_attrs, _ = read_revision(parent, temporary)
            if identity(staged_stat) != identity(os.fstat(staged_fd)) or staged_data != data or staged_attrs != metadata:
                raise Refused('staging replaced')
            os.replace(temporary, pieces[-1], src_dir_fd=parent, dst_dir_fd=parent)
            temporary = None
            os.fsync(parent)
            actual, saved, saved_metadata, baseline = read_revision(parent, pieces[-1])
            if actual != data or saved.st_ino != os.fstat(staged_fd).st_ino or saved_metadata != metadata or (saved.st_uid, saved.st_gid, stat.S_IMODE(saved.st_mode)) != (original.st_uid, original.st_gid, stat.S_IMODE(original.st_mode)):
                raise Conflict('changed after replacement')
        return {'ok': True, 'baseline': baseline, **({'content': base64.b64encode(data).decode('ascii')} if request['op'] == 'read' else {})}
    finally:
        try:
            if temporary is not None and staged_fd is not None: remove_owned(parent, temporary, staged_fd)
        finally:
            if staged_fd is not None: os.close(staged_fd)
            os.close(parent)
try:
    raw = sys.stdin.buffer.read(30 * 1024 * 1024 + 1)
    if len(raw) > 30 * 1024 * 1024: raise Refused('input limit')
    result = run(json.loads(raw))
except Conflict:
    result = {'ok': False, 'conflict': True}
except BaseException:
    result = {'ok': False, 'conflict': False}
print(json.dumps(result, separators=(',', ':')))
`

const refused = '无法验证安全保存条件，请下载后维护（需要支持元数据校验的 Linux 和 Python 3；不支持链接）'
async function execute(client: Client, request: Record<string, unknown>, signal: AbortSignal): Promise<{ baseline: string; content?: string }> {
  signal.throwIfAborted()
  const result = await execOnClient(client, `python3 -c ${shellEscape(ATOMIC_EDIT_SCRIPT)}`, {
    stdin: JSON.stringify(request), signal, timeoutMs: 30_000, maxOutputBytes: 29 * 1024 * 1024
  })
  signal.throwIfAborted()
  if (result.code !== 0 || result.signal || result.timedOut || result.truncated) throw new Error(refused)
  let value: { ok?: boolean; conflict?: boolean; baseline?: string; content?: string }
  try { value = JSON.parse(result.stdout) } catch { throw new Error(refused) }
  if (!value || value.ok !== true) throw new Error(value?.conflict ? '远端文件已被修改，未确认回传；本地副本已保留，请重新打开核对' : refused)
  if (typeof value.baseline !== 'string' || !/^[a-f0-9]{64}$/.test(value.baseline)) throw new Error(refused)
  return { baseline: value.baseline, content: value.content }
}
export async function readAtomicEdit(client: Client, remotePath: string, signal: AbortSignal, proof: EditNamespaceProof): Promise<{ content: Buffer; baseline: string }> {
  const value = await execute(client, { op: 'read', path: remotePath, proof }, signal)
  if (typeof value.content !== 'string' || value.content.length > Math.ceil(EDIT_LIMIT / 3) * 4) throw new Error(refused)
  const content = Buffer.from(value.content, 'base64')
  if (content.length > EDIT_LIMIT || content.toString('base64') !== value.content) throw new Error(refused)
  return { content, baseline: value.baseline }
}
export async function saveAtomicEdit(client: Client, remotePath: string, baseline: string, content: Buffer, signal: AbortSignal, proof: EditNamespaceProof): Promise<{ baseline: string }> {
  if (content.length > EDIT_LIMIT) throw new Error('文件超过 20 MB，请改为下载')
  const result = await execute(client, { op: 'save', path: remotePath, baseline, content: content.toString('base64'), proof }, signal)
  return { baseline: result.baseline }
}
