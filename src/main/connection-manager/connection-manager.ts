import type {
  ConnectionConfig,
  ConnectionProfile,
  CreateConnectionProfileRequest,
  UpdateConnectionProfileRequest
} from '@shared/types/connection-profile'
import type {
  ConnectionProfileRepository,
  CreateConnectionProfileInput,
  UpdateConnectionProfileInput
} from '../local-storage/connection-profile-repository'
import type { SecretStore } from './secret-store'
import type { EntraIdAuthenticator, ServicePrincipalAuthenticator } from './entra-id-authenticator'
import { scopesForDatabaseKind } from './entra-id-scopes'
import type { MsalTokenCacheRepository } from '../local-storage/msal-token-cache-repository'

/**
 * Connection Manager (GLOSSARY.md) — owns Connection Profile CRUD and secret
 * encrypt/decrypt, and (per spec.md's component boundaries) the Entra ID
 * `acquireTokenInteractive` + self-rolled `ICachePlugin` flow. Never holds a
 * live database connection; that is the Query Execution Service's job.
 * Composes the Local Storage Service's ConnectionProfileRepository (opaque
 * ciphertext persistence) with a SecretStore (the actual encrypt/decrypt
 * operation). `authenticator` and `tokenCacheRepository` are optional only
 * so existing account-key/sql-credentials-only call sites (and this
 * class's own tests) don't need to construct them — `resolveSecret()`
 * throws if an entra-id profile is resolved without an authenticator
 * configured, rather than silently returning `undefined` and failing
 * confusingly downstream.
 */
export class ConnectionManager {
  constructor(
    private readonly repository: ConnectionProfileRepository,
    private readonly secretStore: SecretStore,
    private readonly authenticator?: EntraIdAuthenticator,
    private readonly tokenCacheRepository?: MsalTokenCacheRepository,
    private readonly servicePrincipalAuthenticator?: ServicePrincipalAuthenticator
  ) {}

  list(): ConnectionProfile[] {
    return this.repository.list()
  }

  get(id: string): ConnectionProfile | undefined {
    return this.repository.get(id)
  }

  create(request: CreateConnectionProfileRequest): ConnectionProfile {
    const input: CreateConnectionProfileInput = {
      name: request.name,
      readOnly: request.readOnly ?? false,
      config: request.config,
      groupName: request.groupName,
      environment: request.environment,
      secretCiphertext:
        request.secret !== undefined ? this.secretStore.encrypt(request.secret) : undefined
    }
    return this.repository.create(input)
  }

  update(id: string, request: UpdateConnectionProfileRequest): ConnectionProfile {
    // A stored secret belongs to one auth mode (SQL password, Cosmos key, or a
    // service principal's client secret). If the mode changes and no new
    // secret comes with it, keeping the old one would send that credential to
    // the wrong place — e.g. a SQL password to Entra as a client secret.
    const existing = request.config ? this.repository.get(id) : undefined
    const authModeChanged =
      existing !== undefined && existing.config.authMode !== request.config?.authMode
    const input: UpdateConnectionProfileInput = {
      name: request.name,
      readOnly: request.readOnly,
      config: request.config,
      groupName: request.groupName,
      environment: request.environment,
      secretCiphertext:
        request.secret === null
          ? null
          : request.secret !== undefined
            ? this.secretStore.encrypt(request.secret)
            : authModeChanged
              ? null
              : undefined
    }
    return this.repository.update(id, input)
  }

  /** Records a successful connect for the recent-connections list (user story 11). */
  markConnected(id: string): void {
    this.repository.markConnected(id)
  }

  /**
   * Deletes the Connection Profile and, since it has no FK to it (migration
   * 0004's doc — a profile may be deleted while its Query History Entries
   * remain readable, same precedent), its MSAL token cache row too —
   * without this, a deleted entra-id profile's encrypted token cache would
   * silently outlive the profile it belonged to forever.
   */
  delete(id: string): void {
    this.repository.delete(id)
    this.tokenCacheRepository?.delete(id)
  }

  /**
   * Decrypts the stored secret for a Connection Profile, producing a
   * Decrypted Secret for one-time handoff to the Query Execution Service at
   * connect-time (docs/adr/0001-...). Returns undefined when the profile has
   * no stored secret (e.g. an Entra ID profile that mints a token
   * interactively rather than persisting one).
   */
  revealSecret(id: string): string | undefined {
    const ciphertext = this.repository.getSecretCiphertext(id)
    return ciphertext ? this.secretStore.decrypt(ciphertext) : undefined
  }

  /**
   * The single entry point `query-execution-ipc.ts` calls to get whatever
   * secret a profile's `connect()`/`testConnection()` needs — an
   * account-key/password ciphertext decrypt for `account-key`/
   * `sql-credentials`, or a fresh Entra ID access token for `entra-id`.
   * Callers never need to branch on `authMode` themselves; this is what
   * "Connection Manager owns the Entra ID flow" (spec.md §6) means in
   * practice.
   */
  async resolveSecret(
    profile: ConnectionProfile,
    /** A plaintext secret typed into the form for a never-saved Test
     * Connection — there is no stored ciphertext to reveal for it yet. */
    typedSecret?: string
  ): Promise<string | undefined> {
    if (profile.config.authMode === 'service-principal') {
      return this.resolveServicePrincipalToken(profile, typedSecret)
    }
    if (!isEntraIdAuthMode(profile.config)) {
      return this.revealSecret(profile.id)
    }
    if (!profile.config.entraId) {
      throw new Error(
        `Connection "${profile.name}" uses Entra ID auth but has no clientId/tenantId configured`
      )
    }
    if (!this.authenticator) {
      throw new Error('Entra ID authentication is not configured for this application')
    }
    return this.authenticator.acquireToken(
      profile.config.entraId,
      scopesForDatabaseKind(profile.config.kind),
      profile.id
    )
  }

  /**
   * Renews the access token of a *connected* Entra ID / service principal
   * profile when the Query Execution Service asks for one mid-session
   * (docs/adr/0002-...). Silent only: a service principal re-runs its
   * client-credentials exchange, an interactive sign-in uses its cached
   * refresh token — and if that no longer works this rejects rather than
   * opening a browser behind the user's back, leaving "reconnect" as the path.
   */
  async refreshSecret(profile: ConnectionProfile): Promise<string> {
    if (profile.config.authMode === 'service-principal') {
      return this.resolveServicePrincipalToken(profile, undefined)
    }
    if (!isEntraIdAuthMode(profile.config) || !profile.config.entraId || !this.authenticator) {
      throw new Error(`Connection "${profile.name}" has no renewable access token`)
    }
    return this.authenticator.acquireToken(
      profile.config.entraId,
      scopesForDatabaseKind(profile.config.kind),
      profile.id,
      { allowInteractive: false }
    )
  }

  /** Client-credentials sign-in: the client secret is read (or typed) here in
   * main and exchanged for an access token — only the token travels on to the
   * Query Execution Service (ADR 0001). */
  private async resolveServicePrincipalToken(
    profile: ConnectionProfile,
    typedSecret: string | undefined
  ): Promise<string> {
    const config = profile.config
    if (config.kind !== 'azure-sql' || !config.servicePrincipal?.clientId || !config.servicePrincipal.tenantId) {
      throw new Error(
        `Connection "${profile.name}" uses service principal auth but has no client ID/tenant ID configured`
      )
    }
    if (!this.servicePrincipalAuthenticator) {
      throw new Error('Service principal authentication is not configured for this application')
    }
    const clientSecret = typedSecret ?? this.revealSecret(profile.id)
    if (!clientSecret) {
      throw new Error(`Connection "${profile.name}" has no client secret saved — edit it and enter one`)
    }
    return this.servicePrincipalAuthenticator.acquireToken(
      config.servicePrincipal,
      clientSecret,
      scopesForDatabaseKind(config.kind)
    )
  }
}

function isEntraIdAuthMode(config: ConnectionConfig): boolean {
  return config.authMode === 'entra-id'
}
