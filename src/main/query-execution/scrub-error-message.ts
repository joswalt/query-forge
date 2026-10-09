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

/** Matches the error shapes an Azure SQL (tedious "Login failed", AAD
 * token rejected) or Cosmos DB (401 Unauthorized) connection attempt
 * produces when an Entra ID access token has expired or been revoked. Not
 * exhaustive — a best-effort heuristic, not a parsed error code — but
 * covers the common cases well enough to turn "a raw driver error" into
 * "a recognizable, actionable one" (user story 62). */
const EXPIRED_ENTRA_ID_TOKEN_PATTERN = /login failed|token.*(expired|invalid|revoked)|AADSTS|401|unauthorized/i

/**
 * Wraps `toSafeErrorMessage` with user story 62's "clear messaging, a path
 * to re-authenticate" for an `entra-id` connection's failure — ADR 0001
 * hands a Decrypted Secret (here, an access token) to the Query Execution
 * Service once per `connect()`/`testConnection()`; there is no silent
 * mid-session refresh by design, so an expired token surfaces as a normal
 * connection failure unless a Provider recognizes the shape and rewrites
 * it. The path to re-authenticate is simply disconnecting and reconnecting
 * (or re-running Test Connection) — ConnectionManager.resolveSecret()
 * always acquires a fresh token (silently refreshed, or interactively if
 * the cached refresh token is also no longer usable) on the next attempt,
 * so no separate "re-auth" UI action is needed beyond the one that already
 * exists.
 */
export function toConnectionErrorMessage(err: unknown, authMode: string): string {
  const safe = toSafeErrorMessage(err)
  if (authMode === 'entra-id' && EXPIRED_ENTRA_ID_TOKEN_PATTERN.test(safe)) {
    return `Entra ID sign-in has expired or is no longer valid — disconnect and reconnect (or re-run Test Connection) to sign in again. (${safe})`
  }
  return safe
}
