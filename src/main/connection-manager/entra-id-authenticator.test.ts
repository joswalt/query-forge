import { describe, expect, it, vi } from 'vitest'
import type { EntraIdAuthConfig } from '@shared/types/connection-profile'
import {
  MsalEntraIdAuthenticator,
  type PublicClientApplicationFactory,
  type PublicClientApplicationLike
} from './entra-id-authenticator'
import type { TokenCacheStore } from './msal-token-cache-plugin'

const ENTRA_ID: EntraIdAuthConfig = {
  clientId: 'client-123',
  tenantId: 'tenant-456',
  redirectUri: 'http://localhost:51234'
}

function noopTokenCacheStore(): TokenCacheStore {
  return { read: () => undefined, write: () => {} }
}

describe('MsalEntraIdAuthenticator', () => {
  it('acquires a token silently when a cached account already exists', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [{ username: 'user@example.com' }] }),
      acquireTokenSilent: vi.fn(async () => ({ accessToken: 'silent-token' })),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const openBrowser = vi.fn(async () => {})
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      openBrowser,
      () => app
    )

    const token = await authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1')

    expect(token).toBe('silent-token')
    expect(app.acquireTokenInteractive).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it('with allowInteractive: false, never opens a browser — it errors so the user reconnects', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [{ username: 'user@example.com' }] }),
      acquireTokenSilent: vi.fn(async () => Promise.reject(new Error('refresh token expired'))),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const openBrowser = vi.fn(async () => {})
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      openBrowser,
      () => app
    )

    await expect(
      authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1', { allowInteractive: false })
    ).rejects.toThrow(/reconnect/)
    expect(app.acquireTokenInteractive).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it('with allowInteractive: false, still returns a silently renewed token', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [{ username: 'user@example.com' }] }),
      acquireTokenSilent: vi.fn(async () => ({ accessToken: 'silent-token' })),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      async () => {},
      () => app
    )

    await expect(
      authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1', { allowInteractive: false })
    ).resolves.toBe('silent-token')
  })

  it('falls back to an interactive sign-in when no cached account exists', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [] }),
      acquireTokenSilent: vi.fn(async () => ({ accessToken: 'silent-token' })),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const openBrowser = vi.fn(async () => {})
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      openBrowser,
      () => app
    )

    const token = await authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1')

    expect(token).toBe('interactive-token')
    expect(app.acquireTokenInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: ENTRA_ID.redirectUri, scopes: ['scope-a'] })
    )
  })

  it('falls back to interactive when a cached account exists but silent acquisition fails (user story 62)', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [{ username: 'user@example.com' }] }),
      acquireTokenSilent: vi.fn(async () => {
        throw new Error('InteractionRequiredAuthError: refresh token expired')
      }),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      async () => {},
      () => app
    )

    const token = await authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1')

    expect(token).toBe('interactive-token')
  })

  it('opens the system browser (never an embedded window) for interactive sign-in', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [] }),
      acquireTokenSilent: vi.fn(),
      acquireTokenInteractive: vi.fn(async (request) => {
        await request.openBrowser('https://login.microsoftonline.com/authorize?...')
        return { accessToken: 'interactive-token' }
      })
    }
    const openBrowser = vi.fn(async () => {})
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      openBrowser,
      () => app
    )

    await authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1')

    expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('https://'))
  })

  it('scopes the token cache store to the given profile id', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [] }),
      acquireTokenSilent: vi.fn(),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const tokenCacheStoreFor = vi.fn(() => noopTokenCacheStore())
    const authenticator = new MsalEntraIdAuthenticator(
      tokenCacheStoreFor,
      async () => {},
      () => app
    )

    await authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-42')

    expect(tokenCacheStoreFor).toHaveBeenCalledWith('profile-42')
  })

  it('builds the authority URL from the configured tenant id', async () => {
    const app: PublicClientApplicationLike = {
      getTokenCache: () => ({ getAllAccounts: async () => [] }),
      acquireTokenSilent: vi.fn(),
      acquireTokenInteractive: vi.fn(async () => ({ accessToken: 'interactive-token' }))
    }
    const factory: PublicClientApplicationFactory = vi.fn((config) => {
      expect(config.auth.clientId).toBe(ENTRA_ID.clientId)
      expect(config.auth.authority).toBe(`https://login.microsoftonline.com/${ENTRA_ID.tenantId}`)
      return app
    })
    const authenticator = new MsalEntraIdAuthenticator(
      () => noopTokenCacheStore(),
      async () => {},
      factory
    )

    await authenticator.acquireToken(ENTRA_ID, ['scope-a'], 'profile-1')

    expect(factory).toHaveBeenCalledTimes(1)
  })
})
