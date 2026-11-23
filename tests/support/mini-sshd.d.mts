export function startMiniSshd(options?: {
  /** Opt-in Linux Python atomic-edit script fixture; macOS xattrs use an explicit test substitute. */
  atomicEditFixture?: boolean
  tcpipForward?: boolean
  username?: string
  password?: string | null
  publicKey?: string | string[] | null
  authenticate?: (context: import('ssh2').AuthContext) => void
  onAuthentication?: (context: import('ssh2').AuthContext) => void
  onAgentForward?: () => void
  root?: string | null
  onRead?: (operation: { path: string; offset: number; length: number }) => void
  onWrite?: (operation: { path: string; offset: number; length: number }) => void
  /** Optional test gate after closing a file, before acknowledging CLOSE. Disabled by default. */
  beforeFileCloseReply?: () => Promise<void>
}): Promise<{
  port: number
  root: string
  username: string
  readonly acceptedConnections: number
  readonly activeConnections: number
  readonly activeExecs: number
  shellSizes: { cols: number; rows: number }[]
  disconnectAll: () => void
  close: () => Promise<void>
}>
