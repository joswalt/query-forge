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

/** Node/tedious/mssql error codes meaning the socket or DNS path failed
 * (user story 63). Deliberately excludes `ECANCEL`/`AbortError` (user
 * cancel) and mssql's `ETIMEOUT` (a query timeout, user story 36 — not a
 * network drop). */
const NETWORK_ERROR_CODES = new Set([
  'ESOCKET',
  'ECONNCLOSED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EPIPE'
])

/** True when `err` (or its `cause`) carries a network-level error code. */
export function isNetworkInterruption(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Message for an error raised while executing a query or reading metadata
 * on a live connection. A network interruption (user story 63) gets an
 * explicit, actionable message rather than a raw socket error; everything
 * else is just scrubbed. Idempotent on its own output (the rewritten Error
 * has no `code`), so applying it in both a Provider and the service's catch
 * is safe.
 */
export function toExecutionErrorMessage(err: unknown): string {
  const safe = toSafeErrorMessage(err)
  if (isNetworkInterruption(err)) {
    return `Network connection to the database was interrupted — check your connectivity and retry. If it keeps failing, disconnect and reconnect. (${safe})`
  }
  return safe
}
