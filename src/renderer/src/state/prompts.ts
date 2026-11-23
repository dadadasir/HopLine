import { expirePrompt } from '../logic/prompt-queue'
import type { HostKeyPrompt, KeyboardPrompt } from '../../../shared/types'
import { enqueuePrompt, dequeuePrompt } from '../logic/prompt-queue'
import { api, errorText, getState, patch } from './store'
import { toast } from './ui'

export type AuthenticationPrompt =
  | (HostKeyPrompt & { kind: 'hostKey' })
  | (KeyboardPrompt & { kind: 'keyboard' })

export interface PromptsState {
  prompts: AuthenticationPrompt[]
}

export function queueAuthentication(prompt: AuthenticationPrompt): void {
  patch((current) => ({ ...current, prompts: enqueuePrompt(current.prompts, prompt) }))
}

export async function respondAuthentication(
  prompt: AuthenticationPrompt, response: 'reject' | 'once' | 'save' | string[] | null
): Promise<void> {
  if (getState().prompts[0]?.requestId !== prompt.requestId) return
  // Remove synchronously so duplicate clicks cannot answer the following prompt.
  patch((current) => ({ ...current, prompts: dequeuePrompt(current.prompts, prompt.requestId) }))
  try {
    if (prompt.kind === 'hostKey' && typeof response === 'string') {
      await api().ssh.respondHostKey(prompt.requestId, response)
    } else if (prompt.kind === 'keyboard' && typeof response !== 'string') {
      await api().ssh.respondKeyboard(prompt.requestId, response)
    }
  } catch (error) {
    toast(errorText(error), 'err')
  }
}

export function subscribePromptExpiry(): () => void {
  return api().on('prompt:expired', ({ requestId }: { requestId: string }) => {
    patch((current) => ({ ...current, prompts: expirePrompt(current.prompts, requestId) }))
  })
}
