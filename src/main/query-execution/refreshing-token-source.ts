import type { DecryptedSecret, SecretRefresher } from '@shared/types/database-provider'

/** Renew this long before the token's real expiry, so a login that starts
 * just before it lapses never carries a token that dies mid-handshake. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

/** Assumed lifetime of a token whose `exp` claim can't be read. Short on
 * purpose: an unreadable token is renewed early rather than trusted. */
const UNKNOWN_EXPIRY_ASSUMED_LIFETIME_MS = TOKEN_REFRESH_SKEW_MS + 60 * 1000

/** A renewal that failed while the current token was already unusable.
 * Drivers (tedious wraps it in an `AggregateError`) bury the original error;
 * `findTokenRefreshError` digs this one back out so its message — which tells
 * the user to reconnect — is what they see. */
export class TokenRefreshError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `The Entra ID access token expired and could not be renewed: ${reason} If this persists, disconnect and reconnect to sign in again.`
    )
    this.name = 'TokenRefreshError'
    this.cause = cause
  }
}

/** Finds a `TokenRefreshError` in `err`, its `cause` chain, an
 * `AggregateError`'s `errors`, or mssql's `originalError` (its
 * `ConnectionError` wraps the tedious error that way: a failed login is
 * `ConnectionError.originalError` → `AggregateError.errors[n]`). */
export function findTokenRefreshError(err: unknown, depth = 0): TokenRefreshError | undefined {
  if (err instanceof TokenRefreshError) return err
  if (depth >= 5 || !err || typeof err !== 'object') return undefined
  const { cause, errors, originalError } = err as {
    cause?: unknown
    errors?: unknown
    originalError?: unknown
  }
  for (const inner of [cause, originalError, ...(Array.isArray(errors) ? errors : [])]) {
    const found = findTokenRefreshError(inner, depth + 1)
    if (found) return found
  }
  return undefined
}

export interface AccessToken {
  token: string
  expiresOnTimestamp: number
}

/** The `exp` claim of a JWT in epoch ms, or undefined if it can't be read.
 * Unverified decoding — only used to decide *when to renew*, never to trust. */
export function readTokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Hands a Provider a current access token for as long as the connection
 * lives. Starts from the token main handed over at `connect()` and, once that
 * is within `TOKEN_REFRESH_SKEW_MS` of expiring, asks main for a new one via
 * the `SecretRefresher` (ADR 0002). Concurrent callers share one in-flight
 * refresh. With no refresher the initial token is returned unchanged.
 */
export class RefreshingTokenSource {
  private current: AccessToken | undefined
  private inFlight: Promise<AccessToken> | undefined

  constructor(
    initialToken: DecryptedSecret | undefined,
    private readonly refresh: SecretRefresher | undefined,
    private readonly now: () => number = Date.now
  ) {
    if (initialToken !== undefined) this.current = this.describe(initialToken)
  }

  async getToken(): Promise<AccessToken> {
    const current = this.current
    if (current && (!this.refresh || current.expiresOnTimestamp - this.now() > TOKEN_REFRESH_SKEW_MS)) {
      return current
    }
    if (!this.refresh) return { token: '', expiresOnTimestamp: this.now() }

    this.inFlight ??= this.renew(this.refresh, current)
    return this.inFlight
  }

  private async renew(refresh: SecretRefresher, stale: AccessToken | undefined): Promise<AccessToken> {
    try {
      const fresh = this.describe(await refresh())
      this.current = fresh
      return fresh
    } catch (err) {
      // A token still inside its real lifetime is better than failing the
      // login: the renewal was only early. Otherwise surface the reason.
      if (stale && stale.expiresOnTimestamp > this.now()) return stale
      throw new TokenRefreshError(err)
    } finally {
      this.inFlight = undefined
    }
  }

  private describe(token: string): AccessToken {
    return {
      token,
      expiresOnTimestamp: readTokenExpiry(token) ?? this.now() + UNKNOWN_EXPIRY_ASSUMED_LIFETIME_MS
    }
  }
}
