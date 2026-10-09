/** Authentication modes available on an Azure Cosmos DB connection (product-overview.md §4.1). */
export type CosmosAuthMode = 'account-key' | 'entra-id'

/** Authentication modes available on an Azure SQL connection (product-overview.md §4.1). */
export type AzureSqlAuthMode = 'sql-credentials' | 'entra-id'

/**
 * The app-registration parameters `acquireTokenInteractive` needs (spec.md
 * Implementation Decisions: msal-node Authorization Code + PKCE, system
 * browser + loopback redirect). Present only when `authMode === 'entra-id'`
 * — a user who will never register an Entra ID app simply leaves a
 * connection on `account-key`/`sql-credentials` and never fills these in;
 * nothing elsewhere assumes they're populated. `redirectUri` must be a
 * loopback address (`http://localhost:PORT`) — msal-node's loopback
 * redirect flow, not an embedded `BrowserWindow` (spec.md Out of Scope's
 * forbidden alternatives).
 */
export interface EntraIdAuthConfig {
  clientId: string
  tenantId: string
  redirectUri: string
}

export interface CosmosConnectionConfig {
  kind: 'cosmos-db'
  endpoint: string
  authMode: CosmosAuthMode
  entraId?: EntraIdAuthConfig
  database?: string
  container?: string
  connectionTimeoutMs?: number
}

export interface AzureSqlConnectionConfig {
  kind: 'azure-sql'
  server: string
  port?: number
  database: string
  authMode: AzureSqlAuthMode
  entraId?: EntraIdAuthConfig
  username?: string
  encrypt?: boolean
  connectionTimeoutMs?: number
}

export type ConnectionConfig = CosmosConnectionConfig | AzureSqlConnectionConfig

/**
 * The persisted, non-secret description of a database connection (GLOSSARY.md:
 * "Connection Profile"). Never carries plaintext or ciphertext credential
 * material itself — `hasSecret` only reports whether a Secret Ciphertext row
 * exists for this profile.
 */
export interface ConnectionProfile {
  id: string
  name: string
  readOnly: boolean
  config: ConnectionConfig
  hasSecret: boolean
  /** Optional folder/group label (user story 9). */
  groupName?: string
  /** ISO timestamp of the last successful connect (user story 11). */
  lastConnectedAt?: string
  createdAt: string
  updatedAt: string
}

/**
 * Shared request shape for the Connection Manager's public API — used by
 * both the preload bridge (renderer-facing) and `ConnectionManager` itself
 * (main-process), so the two never drift out of sync. `secret`, when
 * present, is plaintext sent once for main to encrypt immediately; it is
 * never echoed back in any response (GLOSSARY.md: "Decrypted Secret").
 */
export interface CreateConnectionProfileRequest {
  name: string
  readOnly?: boolean
  config: ConnectionConfig
  groupName?: string
  secret?: string
}

export interface UpdateConnectionProfileRequest {
  name?: string
  readOnly?: boolean
  config?: ConnectionConfig
  /** `null` clears the group; `undefined` leaves it untouched. */
  groupName?: string | null
  /** `null` clears the stored secret; `undefined` (or omitted) leaves it untouched. */
  secret?: string | null
}

/**
 * Request shape for Test Connection (GLOSSARY.md) — validating connection
 * parameters via the Query Execution Service without persisting anything.
 * Either re-tests an already-saved Connection Profile by id (decrypting
 * its stored secret), or tests unsaved form data directly (user story 6:
 * "test a connection's parameters before saving it") — never both.
 */
export type TestConnectionRequest = { profileId: string } | { config: ConnectionConfig; secret?: string }
