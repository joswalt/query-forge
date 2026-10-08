import sql from 'mssql'
import type { AzureSqlConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'
import type {
  DatabaseMetadata,
  DatabaseMetadataObject,
  DatabaseProvider,
  DecryptedSecret,
  ExecutionId,
  QueryOptions,
  ResultChunk,
  TestResult
} from '@shared/types/database-provider'
import { UnsupportedAuthModeError } from '@shared/types/database-provider'
import { AsyncQueue } from '../async-queue'
import { toSafeErrorMessage } from '../scrub-error-message'

/**
 * The narrow slice of `mssql`'s `ConnectionPool`/`Request` this Provider
 * depends on — small and behavioral enough to fake in unit tests without
 * mocking the whole SDK (codebase-design: depth over breadth at the seam).
 */
export interface SqlQueryResult {
  recordset?: Array<Record<string, unknown>>
}

export interface SqlRequestLike {
  stream: boolean
  query(command: string): Promise<SqlQueryResult>
  cancel(): void
  on(event: 'row', listener: (row: Record<string, unknown>) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  on(event: 'done', listener: () => void): unknown
}

export interface SqlPoolLike {
  connect(): Promise<unknown>
  close(): Promise<void>
  request(): SqlRequestLike
}

export interface SqlConfig {
  server: string
  port?: number
  database: string
  user?: string
  password?: string
  connectionTimeout?: number
  options?: { encrypt?: boolean; trustServerCertificate?: boolean }
}

export type SqlPoolFactory = (config: SqlConfig) => SqlPoolLike

const defaultPoolFactory: SqlPoolFactory = (config) =>
  new sql.ConnectionPool(config) as unknown as SqlPoolLike

/** Row batch size for the streamed `AsyncIterable<ResultChunk>` bridge (user story 31). */
const CHUNK_SIZE = 500

/**
 * Azure SQL Provider (GLOSSARY.md) — the Database Provider Interface
 * implementation backed by `mssql`. Runs inside the Query Execution
 * Service; owns its own `ConnectionPool` and never touches `safeStorage` or
 * Secret Ciphertext directly (ADR 0001).
 */
export class AzureSqlProvider implements DatabaseProvider {
  private pool: SqlPoolLike | undefined
  private readonly activeRequests = new Map<ExecutionId, SqlRequestLike>()

  constructor(private readonly poolFactory: SqlPoolFactory = defaultPoolFactory) {}

  async connect(profile: ConnectionProfile, secret: DecryptedSecret | undefined): Promise<void> {
    const config = requireAzureSqlConfig(profile)
    assertSupportedAuthMode(config.authMode)
    // mssql's pool.connect() is eager — it performs real network I/O,
    // unlike Cosmos's lazy client construction.
    const pool = this.poolFactory(toSqlConfig(config, secret))
    await pool.connect()
    this.pool = pool
  }

  async testConnection(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined
  ): Promise<TestResult> {
    const config = requireAzureSqlConfig(profile)
    try {
      assertSupportedAuthMode(config.authMode)
    } catch (err) {
      return { success: false, message: toSafeErrorMessage(err) }
    }

    // Test Connection (GLOSSARY.md) never populates the live pool — a
    // throwaway pool, never assigned to `this.pool`.
    const pool = this.poolFactory(toSqlConfig(config, secret))
    try {
      await pool.connect()
      await pool.request().query('SELECT 1')
      return { success: true }
    } catch (err) {
      return { success: false, message: toSafeErrorMessage(err) }
    } finally {
      await pool.close().catch(() => {})
    }
  }

  async disconnect(): Promise<void> {
    await this.pool?.close()
    this.pool = undefined
    this.activeRequests.clear()
  }

  async *executeQuery(query: string, options: QueryOptions = {}): AsyncIterable<ResultChunk> {
    if (!this.pool) {
      throw new Error('Azure SQL Provider is not connected')
    }

    const request = this.pool.request()
    request.stream = true
    if (options.executionId) this.activeRequests.set(options.executionId, request)

    const queue = new AsyncQueue<unknown[]>()
    let batch: Record<string, unknown>[] = []

    request.on('row', (row) => {
      batch.push(row)
      if (batch.length >= CHUNK_SIZE) {
        queue.push(batch)
        batch = []
      }
    })
    request.on('error', (err) => {
      queue.fail(new Error(toSafeErrorMessage(err)))
    })
    request.on('done', () => {
      if (batch.length > 0) queue.push(batch)
      queue.close()
    })

    // Errors surface via the 'error' event above (mssql's streaming
    // contract); this catch only prevents an unhandled rejection on the
    // promise mssql also resolves/rejects for the same failure.
    void request.query(query).catch(() => {})

    try {
      for await (const rows of queue) {
        yield { rows }
      }
    } finally {
      if (options.executionId) this.activeRequests.delete(options.executionId)
    }
  }

  cancel(executionId: ExecutionId): void {
    // Azure SQL's cancel is genuine server-side cancellation (TDS
    // Attention packet via Request.cancel()) — GLOSSARY.md: Execution ID.
    // This is the asymmetric half of the documented cancel() contract.
    this.activeRequests.get(executionId)?.cancel()
  }

  async getMetadata(): Promise<DatabaseMetadata> {
    if (!this.pool) {
      throw new Error('Azure SQL Provider is not connected')
    }

    // "Initial metadata discovery" (product-overview.md §11 Phase 2):
    // schemas/tables/columns via INFORMATION_SCHEMA. Primary keys and
    // indexes (user story 15) are deferred to the later Object Explorer
    // UI-polish phase, not part of this slice.
    const { recordset = [] } = await this.pool.request().query(
      `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType
       FROM INFORMATION_SCHEMA.COLUMNS
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
    )

    const schemas = new Map<string, Map<string, DatabaseMetadataObject[]>>()
    for (const row of recordset) {
      const schemaName = String(row.schemaName)
      const tableName = String(row.tableName)
      const tables = schemas.get(schemaName) ?? new Map<string, DatabaseMetadataObject[]>()
      schemas.set(schemaName, tables)
      const columns = tables.get(tableName) ?? []
      tables.set(tableName, columns)
      columns.push({ name: String(row.columnName), kind: 'column', detail: String(row.dataType) })
    }

    const objects: DatabaseMetadataObject[] = []
    for (const [schemaName, tables] of schemas) {
      const tableObjects: DatabaseMetadataObject[] = []
      for (const [tableName, columns] of tables) {
        tableObjects.push({ name: tableName, kind: 'table', children: columns })
      }
      objects.push({ name: schemaName, kind: 'schema', children: tableObjects })
    }
    return { objects }
  }
}

function requireAzureSqlConfig(profile: ConnectionProfile): AzureSqlConnectionConfig {
  if (profile.config.kind !== 'azure-sql') {
    throw new Error(`AzureSqlProvider cannot handle connection kind "${profile.config.kind}"`)
  }
  return profile.config
}

function assertSupportedAuthMode(authMode: AzureSqlConnectionConfig['authMode']): void {
  if (authMode !== 'sql-credentials') {
    throw new UnsupportedAuthModeError(authMode)
  }
}

/**
 * Maps a Connection Profile's Azure SQL config + Decrypted Secret to
 * mssql's config shape. `requestTimeout` (query-level timeout, user story
 * 36) is set pool-wide from the same `connectionTimeoutMs` field —
 * `QueryOptions.timeoutMs` is not yet wired to a true per-query override,
 * since mssql only exposes timeout at pool-creation time, not per
 * `Request`. Flagged here rather than silently ignored.
 */
function toSqlConfig(config: AzureSqlConnectionConfig, secret: DecryptedSecret | undefined): SqlConfig {
  return {
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.username,
    password: secret,
    connectionTimeout: config.connectionTimeoutMs,
    options: {
      encrypt: config.encrypt ?? true,
      trustServerCertificate: false
    }
  }
}
