/**
 * Strips credential-shaped substrings from an error message before it
 * crosses back to the renderer. `mssql`/tedious connection errors can embed
 * the connection config (including `password=`) in their message; Cosmos
 * DB errors are less prone to this but are scrubbed defensively too, since
 * both Providers report failures through the same `TestResult.message` /
 * thrown-error path that ultimately reaches the UI.
 */
export function toSafeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/(password|pwd|key|secret)\s*=\s*[^;,\s]+/gi, '$1=***')
}
