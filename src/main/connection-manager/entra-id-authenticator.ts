import { ConfidentialClientApplication, PublicClientApplication } from '@azure/msal-node'
import type { Configuration } from '@azure/msal-node'
import type { EntraIdAuthConfig, ServicePrincipalConfig } from '@shared/types/connection-profile'
import { MsalTokenCachePlugin, type TokenCacheStore } from './msal-token-cache-plugin'

/**
 * The narrow slice of msal-node's `PublicClientApplication` this
 * authenticator depends on — small and behavioral enough to fake in unit
 * tests without mocking the whole SDK (codebase-design: depth over
 * breadth at the seam, same pattern as `CosmosClientLike`/`SqlPoolLike`).
 */
export interface PublicClientApplicationLike {
  getTokenCache(): {
    getAllAccounts(): Promise<Array<{ username: string }>>
  }
  acquireTokenSilent(request: {
    account: { username: string }
    scopes: string[]
  }): Promise<{ accessToken: string }>
  acquireTokenInteractive(request: {
    scopes: string[]
    redirectUri: string
    openBrowser: BrowserOpener
  }): Promise<{ accessToken: string }>
}

export type PublicClientApplicationFactory = (
  config: Configuration
) => PublicClientApplicationLike

const defaultAppFactory: PublicClientApplicationFactory = (config) =>
  new PublicClientApplication(config) as unknown as PublicClientApplicationLike

/**
 * Connection Manager's Entra ID sign-in flow (spec.md Implementation
 * Decisions: msal-node's interactive Authorization Code + PKCE,
 * `acquireTokenInteractive`, system browser + loopback redirect — never
 * device code, ROPC, or an embedded `BrowserWindow`). Abstracted behind an
 * interface so `ConnectionManager`'s branching logic (resolveSecret) is
 * unit-testable without ever opening a real browser.
 */
export interface EntraIdAuthenticator {
  /**
   * Returns an access token for `scopes` — silently via a cached
   * refresh/account if one exists for this profile, otherwise by opening
   * the system browser for an interactive sign-in. The returned token is
   * handed to the Query Execution Service exactly like any other Decrypted
   * Secret (ADR 0001) — the Database Provider Interface does not
   * distinguish "password" from "AAD access token", both are just the
   * `secret` parameter.
   */
  acquireToken(
    entraId: EntraIdAuthConfig,
    scopes: string[],
    profileId: string,
    options?: AcquireTokenOptions
  ): Promise<string>
}

export interface AcquireTokenOptions {
  /** Defaults to true. Background renewals (a live connection asking for a
   * newer token, ADR 0002) pass false: they must never open a browser
   * unprompted, so a cached account that can't be renewed silently is an
   * error telling the user to reconnect instead. */
  allowInteractive?: boolean
}

/** Opens `url` in the OS's default browser — never an embedded
 * `BrowserWindow` (spec.md's explicitly forbidden alternative). Takes
 * `shell.openExternal` as a parameter rather than importing `electron`
 * directly, so this module (and its tests) have no Electron-runtime
 * dependency of their own. */
export type BrowserOpener = (url: string) => Promise<void>

/**
 * Real implementation, backed by `@azure/msal-node`'s `PublicClientApplication`
 * and the self-rolled `MsalTokenCachePlugin`. One `PublicClientApplication`
 * per `acquireToken` call (not cached across calls) — construction is cheap
 * (no network I/O) and this keeps each call's cache plugin scoped to
 * exactly the one profile id it was given, with no shared mutable state
 * between profiles to reason about.
 */
export class MsalEntraIdAuthenticator implements EntraIdAuthenticator {
  constructor(
    private readonly tokenCacheStoreFor: (profileId: string) => TokenCacheStore,
    private readonly openBrowser: BrowserOpener,
    private readonly appFactory: PublicClientApplicationFactory = defaultAppFactory
  ) {}

  async acquireToken(
    entraId: EntraIdAuthConfig,
    scopes: string[],
    profileId: string,
    options: AcquireTokenOptions = {}
  ): Promise<string> {
    const app = this.appFactory({
      auth: {
        clientId: entraId.clientId,
        authority: `https://login.microsoftonline.com/${entraId.tenantId}`
      },
      cache: { cachePlugin: new MsalTokenCachePlugin(this.tokenCacheStoreFor(profileId)) }
    })

    // Prefer a cached/refreshed token over a fresh interactive sign-in —
    // acquireTokenSilent itself refreshes an expired access token via a
    // cached refresh token when one is available; only a profile with no
    // usable cached account at all falls through to the browser.
    const accounts = await app.getTokenCache().getAllAccounts()
    if (accounts.length > 0) {
      try {
        const silent = await app.acquireTokenSilent({ account: accounts[0], scopes })
        return silent.accessToken
      } catch {
        // Falls through to interactive — e.g. the cached refresh token
        // itself has expired or been revoked (user story 62: this is the
        // "expired credential" case recovering gracefully via a fresh
        // sign-in, rather than surfacing a raw silent-flow error).
      }
    }

    if (options.allowInteractive === false) {
      throw new Error(
        'Entra ID sign-in has expired and could not be renewed silently — disconnect and reconnect to sign in again.'
      )
    }

    const interactive = await app.acquireTokenInteractive({
      scopes,
      redirectUri: entraId.redirectUri,
      openBrowser: this.openBrowser
    })
    return interactive.accessToken
  }
}

/** The slice of msal-node's `ConfidentialClientApplication` the service
 * principal flow uses — faked in unit tests like the public-client one. */
export interface ConfidentialClientApplicationLike {
  acquireTokenByClientCredential(request: {
    scopes: string[]
  }): Promise<{ accessToken: string } | null>
}

export type ConfidentialClientApplicationFactory = (
  config: Configuration & { auth: { clientSecret: string } }
) => ConfidentialClientApplicationLike

const defaultConfidentialFactory: ConfidentialClientApplicationFactory = (config) =>
  new ConfidentialClientApplication(config) as unknown as ConfidentialClientApplicationLike

/**
 * Service principal (app identity) sign-in via the OAuth client-credentials
 * flow: main exchanges the client secret for an access token, and only that
 * token is handed to the Query Execution Service as the Decrypted Secret
 * (ADR 0001) — the client secret itself never leaves main. No browser, no
 * redirect URI, and nothing to cache: a fresh token is minted per
 * `connect()`, Test Connection or mid-session renewal (ADR 0002).
 */
export interface ServicePrincipalAuthenticator {
  acquireToken(
    servicePrincipal: ServicePrincipalConfig,
    clientSecret: string,
    scopes: string[]
  ): Promise<string>
}

export class MsalServicePrincipalAuthenticator implements ServicePrincipalAuthenticator {
  constructor(
    private readonly appFactory: ConfidentialClientApplicationFactory = defaultConfidentialFactory
  ) {}

  async acquireToken(
    servicePrincipal: ServicePrincipalConfig,
    clientSecret: string,
    scopes: string[]
  ): Promise<string> {
    const app = this.appFactory({
      auth: {
        clientId: servicePrincipal.clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${servicePrincipal.tenantId}`
      }
    })
    const result = await app.acquireTokenByClientCredential({ scopes })
    if (!result?.accessToken) {
      throw new Error('Entra ID returned no access token for the service principal')
    }
    return result.accessToken
  }
}
