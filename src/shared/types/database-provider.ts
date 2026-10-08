import type { ConnectionProfile } from './connection-profile'

/**
 * The plaintext form of a credential (GLOSSARY.md: "Decrypted Secret"). Exists
 * only transiently — handed from the Connection Manager to the Query
 * Execution Service once per connect, never persisted or re-transmitted.
 */
export type DecryptedSecret = string

/**
 * Opaque identifier for one in-flight `executeQuery` call (GLOSSARY.md:
 * "Execution ID"), used to address it for `cancel()`.
 */
export type ExecutionId = string

export interface TestResult {
  success: boolean
  message?: string
}

/**
 * One unit of a streamed/paginated query result (GLOSSARY.md: "Result
 * Chunk"). `meta` is provider-specific and optional (e.g. Cosmos's RU
 * charge) — the UI may display it but must not depend on it existing.
 */
export interface ResultChunk {
  rows: unknown[]
  meta?: {
    ru?: number
  }
}

/**
 * The shared, provider-agnostic shape `getMetadata()` returns (GLOSSARY.md:
 * "Database Metadata") — tables/columns for Azure SQL, containers/partition
 * keys for Cosmos DB — consumed by the Object Explorer.
 */
export interface DatabaseMetadataObject {
  name: string
  kind: string
  /** Optional supplementary display info (e.g. a SQL column's data type)
   * that belongs alongside the name, not folded into it. */
  detail?: string
  children?: DatabaseMetadataObject[]
}

export interface DatabaseMetadata {
  objects: DatabaseMetadataObject[]
}

export interface QueryOptions {
  timeoutMs?: number
  /**
   * Assigned by the caller (the Query Execution Service) before invoking
   * `executeQuery`, not by the Database Provider. The locked interface
   * (spec.md) leaves how a caller obtains an Execution ID for `cancel()`
   * unspecified beyond "tracks Execution IDs for cancel()" — this is the
   * concrete resolution: the caller mints the id upfront and a Provider
   * tracks any per-call cancellation state (AbortController, mssql Request)
   * under it. Omitted entirely, `cancel()` has nothing to address.
   */
  executionId?: ExecutionId
}

/**
 * The contract every Database Provider implements (GLOSSARY.md: "Database
 * Provider Interface"). Implementations run inside the Query Execution
 * Service (the shared Electron utilityProcess) — see
 * docs/adr/0001-decrypt-credentials-in-main-pass-plaintext-to-utility-process.md.
 *
 * `cancel()` semantics are asymmetric by design and must not be papered
 * over: Azure SQL's cancel is genuine server-side cancellation; Cosmos DB's
 * is client-side abandonment only (RU charges already incurred stand).
 */
export interface DatabaseProvider {
  connect(profile: ConnectionProfile, secret: DecryptedSecret | undefined): Promise<void>
  testConnection(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined
  ): Promise<TestResult>
  disconnect(): Promise<void>
  executeQuery(query: string, options?: QueryOptions): AsyncIterable<ResultChunk>
  cancel(executionId: ExecutionId): void
  getMetadata(): Promise<DatabaseMetadata>
}

/**
 * Thrown by a Database Provider's `connect`/`testConnection` when asked to
 * use an auth mode it does not yet implement. Currently: `entra-id` on both
 * providers — the msal-node interactive Authorization Code + PKCE flow is a
 * separate, later Connection Manager slice (spec.md's suggested build
 * order puts providers/testing/metadata before query editing, and the full
 * Entra ID flow is tracked separately from both). Never thrown for
 * `account-key` / `sql-credentials`.
 */
export class UnsupportedAuthModeError extends Error {
  constructor(public readonly authMode: string) {
    super(`Auth mode "${authMode}" is not yet supported`)
    this.name = 'UnsupportedAuthModeError'
  }
}
