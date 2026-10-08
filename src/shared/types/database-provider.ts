import type { ConnectionProfile } from './connection-profile'

/**
 * The plaintext form of a credential (GLOSSARY.md: "Decrypted Secret"). Exists
 * only transiently — handed from the Connection Manager to the Query
 * Execution Service once per connect, never persisted or re-transmitted.
 */
export type Secret = string

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
  children?: DatabaseMetadataObject[]
}

export interface DatabaseMetadata {
  objects: DatabaseMetadataObject[]
}

export interface QueryOptions {
  timeoutMs?: number
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
  connect(profile: ConnectionProfile, secret: Secret | undefined): Promise<void>
  testConnection(profile: ConnectionProfile, secret: Secret | undefined): Promise<TestResult>
  disconnect(): Promise<void>
  executeQuery(query: string, options?: QueryOptions): AsyncIterable<ResultChunk>
  cancel(executionId: ExecutionId): void
  getMetadata(): Promise<DatabaseMetadata>
}
