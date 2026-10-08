/** Authentication modes available on an Azure Cosmos DB connection (product-overview.md §4.1). */
export type CosmosAuthMode = 'account-key' | 'entra-id'

/** Authentication modes available on an Azure SQL connection (product-overview.md §4.1). */
export type AzureSqlAuthMode = 'sql-credentials' | 'entra-id'

export interface CosmosConnectionConfig {
  kind: 'cosmos-db'
  endpoint: string
  authMode: CosmosAuthMode
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
  createdAt: string
  updatedAt: string
}
