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
  SecretRefresher,
  TestResult
} from '@shared/types/database-provider'
import { RefreshingTokenSource, type AccessToken } from '../refreshing-token-source'
import { AsyncQueue } from '../async-queue'
import { toConnectionErrorMessage, toExecutionErrorMessage } from '../scrub-error-message'

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
  /** Fires once per row-returning statement, before that statement's rows. */
  on(event: 'recordset', listener: () => void): unknown
  on(event: 'row', listener: (row: Record<string, unknown>) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  on(event: 'done', listener: () => void): unknown
}

export interface SqlPoolLike {
  connect(): Promise<unknown>
  close(): Promise<void>
  request(): SqlRequestLike
  /** Optional so test fakes needn't implement it; the real `ConnectionPool`
   * is an EventEmitter and *must* have an 'error' listener (see connect()). */
  on?(event: 'error', listener: (err: unknown) => void): unknown
}

export interface SqlConfig {
  server: string
  port?: number
  database: string
  user?: string
  password?: string
  /** Present only for `authMode: 'entra-id'` — mssql/tedious's AAD
   * access-token auth block (toSqlConfig's doc has the full rationale for
   * why `user`/`password` are omitted, not merely left undefined, in that
   * branch). */
  authentication?:
    | { type: 'azure-active-directory-access-token'; options: { token: string } }
    // tedious asks the credential for a token on every new login, so a
    // pool that reconnects after the first token expired gets a fresh one
    // (docs/adr/0002-refresh-entra-tokens-over-the-message-port.md).
    | {
        type: 'token-credential'
        options: { credential: { getToken(): Promise<AccessToken> } }
      }
  connectionTimeout?: number
  /** Query timeout in ms (user story 36). mssql's own default is 15s, which
   * would silently kill any longer query. */
  requestTimeout?: number
  options?: { encrypt?: boolean; trustServerCertificate?: boolean }
}

export type SqlPoolFactory = (config: SqlConfig) => SqlPoolLike

const defaultPoolFactory: SqlPoolFactory = (config) =>
  new sql.ConnectionPool(config) as unknown as SqlPoolLike

/** Used when a profile sets no timeout: long enough for real analytic queries,
 * short enough that a runaway query doesn't hang indefinitely (user story 36). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

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

  async connect(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined,
    refreshSecret?: SecretRefresher
  ): Promise<void> {
    const config = requireAzureSqlConfig(profile)
    // mssql's pool.connect() is eager — it performs real network I/O,
    // unlike Cosmos's lazy client construction.
    const pool = this.poolFactory(toSqlConfig(config, secret, refreshSecret))
    // A dropped socket makes the pool emit 'error'; with no listener Node
    // throws it as an uncaught exception, which would kill the shared
    // utilityProcess (every profile, both providers). Swallow it here — the
    // failing in-flight request reports its own error, and mssql
    // re-establishes the connection on the next request (user story 63).
    pool.on?.('error', () => {})
    try {
      await pool.connect()
    } catch (err) {
      // Rewritten (user story 62), not just scrubbed — an expired/invalid
      // Entra ID token surfacing as a raw "Login failed" would otherwise
      // read identically to a wrong-password failure, giving no hint that
      // reconnecting (which re-acquires a token, ConnectionManager.
      // resolveSecret) would actually fix it.
      throw new Error(toConnectionErrorMessage(err, config.authMode, secret))
    }
    this.pool = pool
  }

  async testConnection(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined
  ): Promise<TestResult> {
    const config = requireAzureSqlConfig(profile)

    // Test Connection (GLOSSARY.md) never populates the live pool — a
    // throwaway pool, never assigned to `this.pool`.
    const pool = this.poolFactory(toSqlConfig(config, secret))
    try {
      await pool.connect()
      await pool.request().query('SELECT 1')
      return { success: true }
    } catch (err) {
      return { success: false, message: toConnectionErrorMessage(err, config.authMode, secret) }
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

    const queue = new AsyncQueue<ResultChunk>()
    let batch: Record<string, unknown>[] = []
    // mssql announces each row-returning statement with a 'recordset' event
    // (columns, before its rows). Indexing by that keeps a multi-statement
    // script's Result Sets apart (user story 61); -1 until the first one, so
    // a driver that never announces one still yields set 0.
    let resultSet = -1
    const flush = (): void => {
      if (batch.length === 0) return
      queue.push({ rows: batch, resultSet: Math.max(resultSet, 0) })
      batch = []
    }

    request.on('recordset', () => {
      // A chunk must not span two Result Sets, so close out the previous
      // one's partial batch first. The empty chunk makes a statement that
      // returns no rows still show up as a (zero-row) Result Set.
      flush()
      resultSet += 1
      queue.push({ rows: [], resultSet })
    })
    request.on('row', (row) => {
      batch.push(row)
      if (batch.length >= CHUNK_SIZE) flush()
    })
    request.on('error', (err) => {
      queue.fail(new Error(toExecutionErrorMessage(err)))
    })
    request.on('done', () => {
      flush()
      queue.close()
    })

    // Errors surface via the 'error' event above (mssql's streaming
    // contract); this catch only prevents an unhandled rejection on the
    // promise mssql also resolves/rejects for the same failure.
    void request.query(query).catch(() => {})

    try {
      for await (const chunk of queue) {
        yield chunk
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

    // Schemas, tables/views, columns (with data type and primary-key flag),
    // and indexes (user story 15).
    const { recordset = [] } = await this.pool.request().query(
      `SELECT c.TABLE_SCHEMA AS schemaName, c.TABLE_NAME AS tableName, t.TABLE_TYPE AS tableType,
              c.COLUMN_NAME AS columnName, c.DATA_TYPE AS dataType,
              CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS isPrimaryKey
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       LEFT JOIN (
         SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
       ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`
    )

    // Indexes are best-effort: a login lacking VIEW DEFINITION shouldn't
    // make the whole Object Explorer fail to load.
    let indexRows: Array<Record<string, unknown>> = []
    try {
      const result = await this.pool.request().query(
        `SELECT s.name AS schemaName, o.name AS tableName, i.name AS indexName, i.is_unique AS isUnique
         FROM sys.indexes i
         JOIN sys.objects o ON o.object_id = i.object_id AND o.type IN ('U', 'V')
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE i.name IS NOT NULL
         ORDER BY s.name, o.name, i.name`
      )
      indexRows = result.recordset ?? []
    } catch {
      indexRows = []
    }

    const schemas = new Map<string, Map<string, DatabaseMetadataObject>>()
    for (const row of recordset) {
      const schemaName = String(row.schemaName)
      const tableName = String(row.tableName)
      const tables = schemas.get(schemaName) ?? new Map<string, DatabaseMetadataObject>()
      schemas.set(schemaName, tables)
      let table = tables.get(tableName)
      if (!table) {
        table = { name: tableName, kind: row.tableType === 'VIEW' ? 'view' : 'table', children: [] }
        tables.set(tableName, table)
      }
      const isPrimaryKey = row.isPrimaryKey === 1 || row.isPrimaryKey === true
      table.children!.push({
        name: String(row.columnName),
        kind: 'column',
        detail: isPrimaryKey ? `${String(row.dataType)}, primary key` : String(row.dataType)
      })
    }

    for (const row of indexRows) {
      if (row.indexName === undefined) continue
      const table = schemas.get(String(row.schemaName))?.get(String(row.tableName))
      if (!table) continue
      const unique = row.isUnique === 1 || row.isUnique === true
      table.children!.push({
        name: String(row.indexName),
        kind: 'index',
        detail: unique ? 'unique' : undefined
      })
    }

    const objects: DatabaseMetadataObject[] = []
    for (const [schemaName, tables] of schemas) {
      objects.push({ name: schemaName, kind: 'schema', children: [...tables.values()] })
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

/**
 * Maps a Connection Profile's Azure SQL config + Decrypted Secret to
 * mssql's config shape. `requestTimeout` (query-level timeout, user story
 * 36) is set pool-wide from the same `connectionTimeoutMs` field (default
 * `DEFAULT_REQUEST_TIMEOUT_MS`, not mssql's 15s) —
 * `QueryOptions.timeoutMs` is not yet wired to a true per-query override,
 * since mssql only exposes timeout at pool-creation time, not per
 * `Request`. Flagged here rather than silently ignored.
 *
 * For `authMode: 'entra-id'`, `secret` is an AAD access token (acquired by
 * ConnectionManager.resolveSecret via MsalEntraIdAuthenticator, ADR 0001 —
 * this function has no idea where it came from, only what shape mssql
 * needs it in) — tedious's `azure-active-directory-access-token`
 * authentication type, not `user`/`password`. Both are omitted entirely in
 * that branch (not just left as `undefined`-valued keys): `username` on an
 * entra-id profile is cosmetic-only (the signed-in identity, decided by
 * the token itself, not a separate credential mssql should try to use),
 * and sending a stray `password` field alongside `authentication` risks a
 * tedious/mssql version treating it as a second, conflicting auth method.
 */
function toSqlConfig(
  config: AzureSqlConnectionConfig,
  secret: DecryptedSecret | undefined,
  refreshSecret?: SecretRefresher
): SqlConfig {
  const base = {
    server: config.server,
    port: config.port,
    database: config.database,
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.connectionTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    options: {
      encrypt: config.encrypt ?? true,
      trustServerCertificate: false
    }
  }

  // Both Entra modes hand over an access token minted in main (interactive
  // user sign-in, or a service principal's client-credentials exchange).
  if (config.authMode === 'entra-id' || config.authMode === 'service-principal') {
    // A live connection gets a token-credential so each pool login can use a
    // renewed token. Without a refresher (Test Connection's throwaway pool)
    // the single token is passed straight through, as before.
    if (refreshSecret) {
      const source = new RefreshingTokenSource(secret, refreshSecret)
      return {
        ...base,
        authentication: {
          type: 'token-credential',
          options: { credential: { getToken: () => source.getToken() } }
        }
      }
    }
    return {
      ...base,
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: secret ?? '' }
      }
    }
  }

  return { ...base, user: config.username, password: secret }
}
