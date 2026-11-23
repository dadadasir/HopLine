export function startMiniAgent(privateKeys: string[]): Promise<{
  socket: string
  signedKeys: Buffer[]
  readonly identityRequests: number
  close: () => Promise<void>
}>
export function generateAgentKey(): { private: string; public: string }
