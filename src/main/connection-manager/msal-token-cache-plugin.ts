import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node'

/**
 * Where a `MsalTokenCachePlugin` reads/writes the serialized cache string
 * for one Connection Profile's `PublicClientApplication` — an abstraction
 * so the plugin itself has no SQLite/`safeStorage` dependency (unit-testable
 * with a plain in-memory fake), mirroring `SecretStore`'s role for
 * credential secrets. The real implementation (entra-id-authenticator.ts)
 * composes `MsalTokenCacheRepository` (opaque ciphertext) with
 * `SecretStore` (encrypt/decrypt) the same way `ConnectionManager` does for
 * account-key/password secrets.
 */
export interface TokenCacheStore {
  read(): string | undefined
  write(serializedCache: string): void
}

/**
 * The self-rolled `ICachePlugin` spec.md's Implementation Decisions calls
 * for ("no keytar, no @azure/msal-node-extensions"). msal-node calls
 * `beforeCacheAccess` before every token operation (silent or interactive)
 * and `afterCacheAccess` after, with `cacheHasChanged` set only when the
 * in-memory cache actually changed — skipping the write when it hasn't
 * avoids re-encrypting and re-persisting an unchanged cache on every
 * silent-token check.
 */
export class MsalTokenCachePlugin implements ICachePlugin {
  constructor(private readonly store: TokenCacheStore) {}

  async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    const serialized = this.store.read()
    if (serialized !== undefined) {
      context.tokenCache.deserialize(serialized)
    }
  }

  async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (context.cacheHasChanged) {
      this.store.write(context.tokenCache.serialize())
    }
  }
}
