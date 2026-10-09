import sql from 'mssql'
import { describe, expect, it, vi } from 'vitest'
import {
  RefreshingTokenSource,
  TOKEN_REFRESH_SKEW_MS,
  TokenRefreshError,
  findTokenRefreshError,
  readTokenExpiry
} from './refreshing-token-source'

/** An unsigned JWT-shaped string carrying only an `exp` claim (epoch seconds). */
function jwtExpiringAt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')
  return `header.${payload}.signature`
}

const NOW = 1_800_000_000_000

describe('readTokenExpiry', () => {
  it('reads the exp claim in ms', () => {
    expect(readTokenExpiry(jwtExpiringAt(NOW))).toBe(Math.floor(NOW / 1000) * 1000)
  })

  it('returns undefined for a token that is not a readable JWT', () => {
    expect(readTokenExpiry('opaque')).toBeUndefined()
    expect(readTokenExpiry('a.!!!.c')).toBeUndefined()
  })
})

describe('RefreshingTokenSource', () => {
  it('returns the initial token while it is well inside its lifetime', async () => {
    const refresh = vi.fn(async () => 'fresh')
    const initial = jwtExpiringAt(NOW + 60 * 60 * 1000)
    const source = new RefreshingTokenSource(initial, refresh, () => NOW)

    expect((await source.getToken()).token).toBe(initial)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes once the token is within the skew of expiring, then caches the new one', async () => {
    const fresh = jwtExpiringAt(NOW + 60 * 60 * 1000)
    const refresh = vi.fn(async () => fresh)
    const source = new RefreshingTokenSource(
      jwtExpiringAt(NOW + TOKEN_REFRESH_SKEW_MS - 1000),
      refresh,
      () => NOW
    )

    expect((await source.getToken()).token).toBe(fresh)
    expect((await source.getToken()).token).toBe(fresh)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight refresh between concurrent callers', async () => {
    let resolveRefresh: (token: string) => void = () => {}
    const refresh = vi.fn(() => new Promise<string>((resolve) => (resolveRefresh = resolve)))
    const source = new RefreshingTokenSource(jwtExpiringAt(NOW - 1000), refresh, () => NOW)

    const a = source.getToken()
    const b = source.getToken()
    resolveRefresh('fresh')

    expect((await a).token).toBe('fresh')
    expect((await b).token).toBe('fresh')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps using a still-valid token when an early refresh fails', async () => {
    const stale = jwtExpiringAt(NOW + 60 * 1000)
    const source = new RefreshingTokenSource(stale, async () => Promise.reject(new Error('offline')), () => NOW)

    expect((await source.getToken()).token).toBe(stale)
  })

  it('throws a TokenRefreshError when the token has expired and the refresh fails', async () => {
    const source = new RefreshingTokenSource(
      jwtExpiringAt(NOW - 1000),
      async () => Promise.reject(new Error('refresh token revoked')),
      () => NOW
    )

    await expect(source.getToken()).rejects.toBeInstanceOf(TokenRefreshError)
    await expect(source.getToken()).rejects.toThrow(/refresh token revoked.*reconnect/s)
  })

  it('retries after a failed refresh instead of caching the failure', async () => {
    const refresh = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce('fresh')
    const source = new RefreshingTokenSource(jwtExpiringAt(NOW - 1000), refresh, () => NOW)

    await expect(source.getToken()).rejects.toBeInstanceOf(TokenRefreshError)
    expect((await source.getToken()).token).toBe('fresh')
  })

  it('treats a token with no readable expiry as short-lived', async () => {
    const refresh = vi.fn(async () => 'fresh')
    let now = NOW
    const source = new RefreshingTokenSource('opaque', refresh, () => now)

    expect((await source.getToken()).token).toBe('opaque')
    now += 2 * 60 * 1000
    expect((await source.getToken()).token).toBe('fresh')
  })

  it('never refreshes without a refresher', async () => {
    const source = new RefreshingTokenSource(jwtExpiringAt(NOW - 1000), undefined, () => NOW)

    expect((await source.getToken()).token).toBe(jwtExpiringAt(NOW - 1000))
  })
})

describe('findTokenRefreshError', () => {
  it('finds one wrapped in an AggregateError or a cause chain', () => {
    const inner = new TokenRefreshError(new Error('x'))
    expect(findTokenRefreshError(new AggregateError([new Error('a'), inner]))).toBe(inner)
    expect(findTokenRefreshError(new Error('outer', { cause: inner }))).toBe(inner)
  })

  it("finds one inside a real mssql ConnectionError, as a failed tedious login produces it", () => {
    const inner = new TokenRefreshError(new Error('x'))
    // tedious: AggregateError([ConnectionError('Security token could not be ...'), cause]);
    // mssql then wraps that as ConnectionError(originalError).
    const tediousFailure = new AggregateError([new Error('Security token could not be authenticated'), inner])
    const wrapped = new sql.ConnectionError(tediousFailure as unknown as Error)

    expect(findTokenRefreshError(wrapped)).toBe(inner)
  })

  it('returns undefined for unrelated errors', () => {
    expect(findTokenRefreshError(new Error('nope'))).toBeUndefined()
    expect(findTokenRefreshError('string')).toBeUndefined()
  })
})
