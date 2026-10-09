import type { MsalTokenCacheRepository } from '../local-storage/msal-token-cache-repository'
import type { TokenCacheStore } from './msal-token-cache-plugin'
import type { SecretStore } from './secret-store'

/**
 * The real `TokenCacheStore` — composes `MsalTokenCacheRepository` (opaque
 * ciphertext persistence) with `SecretStore` (encrypt/decrypt), the same
 * division of responsibility `ConnectionManager` uses for account-key/
 * password secrets. Scoped to one profile id per instance (constructed
 * fresh per `acquireToken` call by `entra-id-authenticator.ts`'s
 * `tokenCacheStoreFor`).
 */
export class SqliteTokenCacheStore implements TokenCacheStore {
  constructor(
    private readonly repository: MsalTokenCacheRepository,
    private readonly secretStore: SecretStore,
    private readonly profileId: string
  ) {}

  read(): string | undefined {
    const ciphertext = this.repository.get(this.profileId)
    return ciphertext ? this.secretStore.decrypt(ciphertext) : undefined
  }

  write(serializedCache: string): void {
    this.repository.set(this.profileId, this.secretStore.encrypt(serializedCache))
  }
}
