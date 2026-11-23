import { translate } from '../i18n'
import { errorText, getState } from '../state/store'

/** Read the language when an asynchronous transfer fails, not when it started. */
export function transferErrorText(error: unknown): string {
  return translate(getState().settings?.language ?? 'zh', errorText(error))
}
