export function runbookError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:Error|AbortError|KeystoreReadError):\s*/, '')
}
