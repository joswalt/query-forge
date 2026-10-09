import type Database from 'better-sqlite3'

interface MsalTokenCacheRow {
  profile_id: string
  ciphertext: Buffer
  updated_at: string
}

/**
 * Local Storage Service component owning MSAL token cache persistence —
 * its own table, not a reuse of `connection_profiles.secret_ciphertext`
 * (see migration 0004's doc for why). Stores only opaque ciphertext, same
 * division of responsibility as `ConnectionProfileRepository`: encryption
 * and decryption belong to the caller (the Entra ID authenticator's token
 * cache store, via `SecretStore`), not to this repository.
 */
export class MsalTokenCacheRepository {
  constructor(private readonly db: Database.Database) {}

  get(profileId: string): Buffer | undefined {
    const row = this.db
      .prepare('SELECT * FROM msal_token_cache WHERE profile_id = ?')
      .get(profileId) as MsalTokenCacheRow | undefined
    return row?.ciphertext
  }

  set(profileId: string, ciphertext: Buffer): void {
    this.db
      .prepare(
        `INSERT INTO msal_token_cache (profile_id, ciphertext, updated_at)
         VALUES (@profileId, @ciphertext, @updatedAt)
         ON CONFLICT(profile_id) DO UPDATE SET ciphertext = @ciphertext, updated_at = @updatedAt`
      )
      .run({ profileId, ciphertext, updatedAt: new Date().toISOString() })
  }

  delete(profileId: string): void {
    this.db.prepare('DELETE FROM msal_token_cache WHERE profile_id = ?').run(profileId)
  }
}
