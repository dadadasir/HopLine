// Test-only Linux capability substitute for macOS loopback. Real file descriptors,
// permissions, hashes and rename run on the host; empty xattrs are simulated.
// This is not evidence that a Linux server or real ACL/xattr preservation passed.
export const ATOMIC_EDIT_PYTHON_SHIM = String.raw`
import os, sys, fcntl
fcntl.ioctl = lambda fd, request, buffer, mutate: 0
sys.platform = 'linux'
os.listxattr = lambda fd: []
def fixture_missing_xattr(*args): raise OSError('fixture has no extended attributes')
os.getxattr = fixture_missing_xattr
os.setxattr = fixture_missing_xattr
os.removexattr = fixture_missing_xattr
`

export const ATOMIC_EDIT_FIXTURE_RUNNER = String.raw`
import os, sys, json, shlex, io
parts = shlex.split(sys.argv[1])
if len(parts) != 3 or parts[:2] != ['python3', '-c']:
    raise RuntimeError('unexpected atomic-edit command')
request = json.load(sys.stdin)
root = os.path.realpath(sys.argv[2])
request['path'] = root + '/' + request['path'].lstrip('/')
sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
` + ATOMIC_EDIT_PYTHON_SHIM + '\nexec(parts[2])\n'
