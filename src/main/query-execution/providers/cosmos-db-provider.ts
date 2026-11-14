import { CosmosClient } from '@azure/cosmos'
import type { ConnectionProfile, CosmosConnectionConfig } from '@shared/types/connection-profile'
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
import { MAX_PATCH_OPERATIONS } from '@shared/types/document-writer'
import type {
  DocumentPatchOperation,
  DocumentWrite,
  DocumentWriteOptions,
  DocumentWriteResult,
  DocumentWriter,
  PartitionKeyValue,
  ReadDocumentRequest,
  ReadDocumentResult,
  StoredDocument
} from '@shared/types/document-writer'
import { RefreshingTokenSource } from '../refreshing-token-source'
import { toConnectionErrorMessage } from '../scrub-error-message'

/**
 * The narrow slice of `@azure/cosmos`'s `CosmosClient` this Provider
 * depends on — small and behavioral enough to fake in unit tests without
 * mocking the whole SDK (codebase-design: depth over breadth at the seam).
 */
export interface CosmosClientLike {
  readonly databases: {
    readAll(): { fetchAll(): Promise<{ resources: Array<{ id: string }> }> }
  }
  database(id: string): CosmosDatabaseLike
  dispose?(): void
}

export interface CosmosDatabaseLike {
  read(): Promise<unknown>
  container(id: string): CosmosContainerLike
  readonly containers: {
    readAll(): {
      fetchAll(): Promise<{
        resources: Array<{ id: string; partitionKey?: { paths?: string[] } }>
      }>
    }
  }
}

export interface CosmosFeedResponseLike {
  resources: unknown[]
  requestCharge: number
  /** `FeedResponse.hasMoreResults` — true while a continuation token remains. */
  hasMoreResults?: boolean
}

/** The `RequestOptions` this Provider sets on a point operation. The
 * access condition `type` is a plain string in the SDK, and anything other
 * than exactly `"IfMatch"` silently becomes If-None-Match, so it is pinned
 * here. `contentResponseOnWriteEnabled` is deliberately absent: setting it
 * to false throws on non-batch item operations. */
export interface CosmosItemOptionsLike {
  accessCondition?: { type: 'IfMatch'; condition: string }
  priorityLevel?: 'Low'
}

/** `ItemResponse`'s useful slice: `resource` is `undefined` for a 404 read. */
export interface CosmosItemResponseLike {
  resource?: unknown
  requestCharge: number
}

export type CosmosPatchOperationLike =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'remove'; path: string }

/** `container.item(id, partitionKey)`'s point operations. */
export interface CosmosItemLike {
  read(options?: CosmosItemOptionsLike): Promise<CosmosItemResponseLike>
  replace(body: unknown, options?: CosmosItemOptionsLike): Promise<CosmosItemResponseLike>
  patch(
    body: { operations: CosmosPatchOperationLike[] },
    options?: CosmosItemOptionsLike
  ): Promise<CosmosItemResponseLike>
  delete(options?: CosmosItemOptionsLike): Promise<CosmosItemResponseLike>
}

export interface CosmosContainerLike {
  read(): Promise<{ resource?: { partitionKey?: { paths?: string[] } } }>
  /** Always called with an explicit partition key: the SDK targets the
   * None key when it is omitted (ADR 0004). */
  item(id: string, partitionKey: PartitionKeyValue): CosmosItemLike
  readonly items: {
    create(body: object, options?: CosmosItemOptionsLike): Promise<CosmosItemResponseLike>
    query(
      query: string,
      options?: { maxItemCount?: number; abortSignal?: AbortSignal }
    ): { getAsyncIterator(): AsyncIterable<CosmosFeedResponseLike> }
  }
}

/** A minimal `@azure/core-auth` `TokenCredential` shape — just enough for
 * `CosmosClient`'s `aadCredentials` option, not the full SDK type (depth
 * over breadth at the seam, same rationale as `CosmosClientLike`). */
export interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>
}

export interface CosmosClientFactoryOptions {
  endpoint: string
  key?: string
  aadCredentials?: TokenCredentialLike
  /** Per-request timeout in ms (the profile's timeout, user story 2). */
  requestTimeoutMs?: number
}

export type CosmosClientFactory = (options: CosmosClientFactoryOptions) => CosmosClientLike

/**
 * Throttling (HTTP 429) retry policy (user story 33). These match the
 * `@azure/cosmos` SDK's own defaults but are stated explicitly so the
 * behavior is a documented decision, not an invisible SDK default: the SDK
 * honors the server's `x-ms-retry-after-ms`, retrying up to 9 times for at
 * most 30s cumulative wait before surfacing the 429.
 */
export const COSMOS_RETRY_OPTIONS = {
  maxRetryAttemptCount: 9,
  fixedRetryIntervalInMilliseconds: 0,
  maxWaitTimeInSeconds: 30
} as const

/**
 * The `connectionPolicy` every Cosmos client is built with.
 *
 * `enableEndpointDiscovery` is deliberately **off**. With it on, the SDK
 * first resolves the account's read/write regions, and when that lookup
 * fails at the network level (typo'd host, DNS failure, no connectivity) it
 * retries in a loop that outlives both `requestTimeout` and an
 * `AbortSignal` — measured at 60s+ with no result, which left "Test
 * connection" spinning and made Cancel ineffective. With it off the SDK
 * talks to the endpoint the user typed and surfaces `ENOTFOUND` /
 * `ECONNREFUSED` immediately.
 *
 * Tradeoff: no SDK-driven failover to other regions of a geo-replicated
 * account. For an interactive query tool pointed at one explicit endpoint
 * that is the right trade; revisit if multi-region failover is ever needed.
 */
export function buildCosmosConnectionPolicy(requestTimeoutMs: number | undefined): {
  enableEndpointDiscovery: false
  retryOptions: typeof COSMOS_RETRY_OPTIONS
  requestTimeout?: number
} {
  return {
    enableEndpointDiscovery: false,
    retryOptions: { ...COSMOS_RETRY_OPTIONS },
    ...(requestTimeoutMs ? { requestTimeout: requestTimeoutMs } : {})
  }
}

const defaultClientFactory: CosmosClientFactory = ({ requestTimeoutMs, ...options }) =>
  new CosmosClient({
    ...options,
    connectionPolicy: buildCosmosConnectionPolicy(requestTimeoutMs)
  } as ConstructorParameters<typeof CosmosClient>[0]) as unknown as CosmosClientLike

/**
 * Wraps an Entra ID access token (ConnectionManager.resolveSecret, via
 * MsalEntraIdAuthenticator) as a `TokenCredential` — `@azure/cosmos`'s
 * `aadCredentials` expects something `getToken()`-shaped, not a bare string.
 * With a `refreshSecret`, the token is renewed through main shortly before it
 * expires (docs/adr/0002-refresh-entra-tokens-over-the-message-port.md) and
 * the real expiry is reported so the SDK's own token cache refreshes on time;
 * without one (Test Connection's throwaway client) the single token is reused.
 */
function tokenCredential(
  token: string,
  refreshSecret: SecretRefresher | undefined
): TokenCredentialLike {
  const source = new RefreshingTokenSource(token, refreshSecret)
  return {
    async getToken() {
      return source.getToken()
    }
  }
}

/**
 * Maps a Cosmos config + Decrypted Secret to `CosmosClient`'s constructor
 * options. For `authMode: 'entra-id'`, `secret` is an AAD access token, not
 * an account key — `aadCredentials`, with `key` omitted entirely (sending
 * both would be ambiguous about which auth method the SDK should actually
 * use).
 */
function toCosmosClientOptions(
  config: CosmosConnectionConfig,
  secret: DecryptedSecret | undefined,
  refreshSecret?: SecretRefresher
): CosmosClientFactoryOptions {
  if (config.authMode === 'entra-id') {
    return {
      endpoint: config.endpoint,
      aadCredentials: tokenCredential(secret ?? '', refreshSecret),
      requestTimeoutMs: config.connectionTimeoutMs
    }
  }
  return { endpoint: config.endpoint, key: secret, requestTimeoutMs: config.connectionTimeoutMs }
}

/** Page size for `items.query`'s continuation-token-driven iterator (user story 32). */
const DEFAULT_PAGE_SIZE = 100

/**
 * Cosmos DB Provider (GLOSSARY.md) — the Database Provider Interface
 * implementation backed by `@azure/cosmos`. Runs inside the Query Execution
 * Service; owns its own `CosmosClient` and never touches `safeStorage` or
 * Secret Ciphertext directly (ADR 0001).
 */
export class CosmosDbProvider implements DatabaseProvider, DocumentWriter {
  private client: CosmosClientLike | undefined
  private config: CosmosConnectionConfig | undefined
  private readonly abortControllers = new Map<ExecutionId, AbortController>()
  /** Each container's partition key paths, read once from its definition
   * and keyed by database/container. A container's partition key can't
   * change, so entries are never invalidated, only dropped on disconnect. */
  private readonly partitionKeyPathsByContainer = new Map<string, Promise<string[]>>()

  constructor(private readonly clientFactory: CosmosClientFactory = defaultClientFactory) {}

  async connect(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined,
    refreshSecret?: SecretRefresher
  ): Promise<void> {
    const config = requireCosmosConfig(profile)
    // CosmosClient's constructor performs no network I/O — connect() is
    // lazy by design (unlike Azure SQL's eager pool.connect()). Because of
    // that laziness, an expired/invalid Entra ID token isn't discovered
    // here; it surfaces as a toConnectionErrorMessage-rewritten failure
    // from the first real call (executeQuery/getMetadata) instead.
    this.client = this.clientFactory(toCosmosClientOptions(config, secret, refreshSecret))
    this.config = config
  }

  async testConnection(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined
  ): Promise<TestResult> {
    const config = requireCosmosConfig(profile)

    // Test Connection (GLOSSARY.md) never populates the live pool — a
    // throwaway client, never assigned to `this.client`.
    const client = this.clientFactory(toCosmosClientOptions(config, secret))
    try {
      if (config.database) {
        await client.database(config.database).read()
      } else {
        await client.databases.readAll().fetchAll()
      }
      return { success: true }
    } catch (err) {
      return { success: false, message: toConnectionErrorMessage(err, config.authMode) }
    } finally {
      client.dispose?.()
    }
  }

  async disconnect(): Promise<void> {
    this.client?.dispose?.()
    this.client = undefined
    this.config = undefined
    this.abortControllers.clear()
    this.partitionKeyPathsByContainer.clear()
  }

  async *executeQuery(query: string, options: QueryOptions = {}): AsyncIterable<ResultChunk> {
    const container = this.requireContainer(options)

    const controller = new AbortController()
    if (options.executionId) this.abortControllers.set(options.executionId, controller)

    try {
      // Cross-partition query and continuation-token handling (user story
      // 32) are both automatic here — @azure/cosmos's iterator manages
      // continuation tokens internally, and omitting `partitionKey` from
      // the query options allows the SDK to fan out across partitions.
      // 429 (RU throttling) retry (user story 33) relies on the SDK's
      // default RetryOptions (exponential backoff, enabled unless
      // explicitly disabled) rather than hand-rolled retry logic.
      const iterator = container.items
        .query(query, { maxItemCount: DEFAULT_PAGE_SIZE, abortSignal: controller.signal })
        .getAsyncIterator()

      // Read (once per container) alongside the first page. Best-effort:
      // without it no row is addressable, but the query still runs.
      const partitionKeyPaths = this.partitionKeyPathsOf(options).catch(() => undefined)
      let isFirstChunk = true

      const maxRows = options.maxRows
      let returned = 0
      for await (const page of iterator) {
        const remaining = maxRows === undefined ? Infinity : maxRows - returned
        const rows =
          page.resources.length > remaining ? page.resources.slice(0, remaining) : page.resources
        returned += rows.length

        const capped = maxRows !== undefined && returned >= maxRows
        // Truncated only if rows were actually left behind: this page was
        // sliced, or the server still holds a continuation. A query with
        // exactly `maxRows` results is therefore not flagged.
        const truncated = capped && (rows.length < page.resources.length || !!page.hasMoreResults)
        const paths = isFirstChunk ? await partitionKeyPaths : undefined
        isFirstChunk = false
        yield {
          rows,
          meta: {
            ru: page.requestCharge,
            ...(truncated ? { truncated: true } : {}),
            ...(paths ? { partitionKeyPaths: paths } : {})
          }
        }

        // Leaving the loop calls the SDK iterator's `return()`; it fetches
        // one page per `next()`, so nothing further is requested or charged.
        // Deliberately no `controller.abort()`: with nothing in flight it
        // buys nothing, and an abort can reject an SDK promise nobody awaits.
        if (capped) break
      }
    } finally {
      if (options.executionId) this.abortControllers.delete(options.executionId)
    }
  }

  cancel(executionId: ExecutionId): void {
    // Cosmos DB's cancel is client-side abandonment only, via AbortSignal —
    // RU charges already incurred stand, and the request may still
    // complete server-side (GLOSSARY.md: Execution ID). This is the
    // asymmetric half of the documented cancel() contract.
    this.abortControllers.get(executionId)?.abort()
  }

  async getMetadata(): Promise<DatabaseMetadata> {
    if (!this.client) {
      throw new Error('Cosmos DB Provider is not connected')
    }

    if (!this.config?.database) {
      // Account-scoped profile: list every database with its containers so
      // the Object Explorer can open any of them (user story 14).
      const { resources } = await this.client.databases.readAll().fetchAll()
      const objects: DatabaseMetadataObject[] = []
      for (const d of resources) {
        const { resources: containers } = await this.client
          .database(d.id)
          .containers.readAll()
          .fetchAll()
        objects.push({
          name: d.id,
          kind: 'database',
          children: containers.map((c) => toContainerObject(c.id, d.id, c.partitionKey?.paths))
        })
      }
      return { objects }
    }

    const databaseId = this.config.database
    const database = this.client.database(databaseId)

    if (!this.config.container) {
      // `containers.readAll` already carries each container's partition
      // key definition, so its children cost nothing extra.
      const { resources } = await database.containers.readAll().fetchAll()
      return {
        objects: resources.map((c) => toContainerObject(c.id, databaseId, c.partitionKey?.paths))
      }
    }

    return {
      objects: [
        toContainerObject(this.config.container, databaseId, await this.partitionKeyPathsOf())
      ]
    }
  }

  async writeDocument(
    write: DocumentWrite,
    options: DocumentWriteOptions = {}
  ): Promise<DocumentWriteResult> {
    const container = this.requireContainer(write)
    const priority: CosmosItemOptionsLike = options.priorityLevel
      ? { priorityLevel: options.priorityLevel }
      : {}
    const ifMatch = (etag: string): CosmosItemOptionsLike => ({
      accessCondition: { type: 'IfMatch', condition: etag },
      ...priority
    })
    try {
      switch (write.kind) {
        case 'create': {
          // `items.create` takes its partition key from the body, so the
          // body must agree with the address; and it invents a random `id`
          // when the body has none, so the `id` is always sent explicitly.
          assertBodyMatchesAddress(write, await this.partitionKeyPathsOf(write))
          return stored(await container.items.create({ ...write.body, id: write.id }, priority))
        }
        case 'replace':
          return stored(
            await container
              .item(write.id, write.partitionKey)
              .replace(write.body, ifMatch(write.ifMatch))
          )
        case 'patch':
          if (write.operations.length > MAX_PATCH_OPERATIONS) {
            throw new Error(
              `A patch can change at most ${MAX_PATCH_OPERATIONS} properties at once (got ${write.operations.length}).`
            )
          }
          return stored(
            await container
              .item(write.id, write.partitionKey)
              .patch(
                { operations: write.operations.map(toSdkPatchOperation) },
                ifMatch(write.ifMatch)
              )
          )
        case 'delete': {
          const { requestCharge } = await container
            .item(write.id, write.partitionKey)
            .delete(ifMatch(write.ifMatch))
          return { outcome: 'success', requestCharge }
        }
      }
    } catch (err) {
      const outcome = EXPECTED_WRITE_FAILURES.get(statusCodeOf(err))
      if (outcome) return { outcome, requestCharge: errorRequestCharge(err) }
      throw err
    }
  }

  async readDocument(request: ReadDocumentRequest): Promise<ReadDocumentResult> {
    const { resource, requestCharge } = await this.requireContainer(request)
      .item(request.id, request.partitionKey)
      .read()
    // The SDK resolves a 404 point-read with `resource: undefined` instead
    // of throwing.
    if (resource === undefined) return { outcome: 'not-found', requestCharge }
    return { outcome: 'success', document: resource as StoredDocument, requestCharge }
  }

  /** The container's partition key paths from its cached definition. A
   * failed read is not cached, so the next call tries again. */
  private partitionKeyPathsOf(target?: { database?: string; container?: string }): Promise<string[]> {
    const container = this.requireContainer(target)
    const key = JSON.stringify([
      target?.database ?? this.config?.database,
      target?.container ?? this.config?.container
    ])
    let paths = this.partitionKeyPathsByContainer.get(key)
    if (!paths) {
      paths = container.read().then(({ resource }) => resource?.partitionKey?.paths ?? [])
      this.partitionKeyPathsByContainer.set(key, paths)
      paths.catch(() => {
        if (this.partitionKeyPathsByContainer.get(key) === paths) {
          this.partitionKeyPathsByContainer.delete(key)
        }
      })
    }
    return paths
  }

  /** Centralizes the "connected, with database + container configured"
   * precondition that both `executeQuery` and `getMetadata`'s fully-scoped
   * branch need, rather than repeating the `client.database(...).container(...)`
   * chain at each call site. */
  private requireContainer(options?: {
    database?: string
    container?: string
  }): CosmosContainerLike {
    const database = options?.database ?? this.config?.database
    const container = options?.container ?? this.config?.container
    if (!this.client || !database || !container) {
      throw new Error(
        'Cosmos DB queries need a database and container — set them on the connection, or open a container from the Object Explorer.'
      )
    }
    return this.client.database(database).container(container)
  }
}

/** A container node for Database Metadata, with its partition key paths as
 * `partition-key` children. */
function toContainerObject(
  name: string,
  database: string,
  partitionKeyPaths: string[] = []
): DatabaseMetadataObject {
  return {
    name,
    kind: 'container',
    database,
    children: partitionKeyPaths.map((path) => ({ name: path, kind: 'partition-key' }))
  }
}

/** The HTTP statuses a Document Write expects and reports as typed
 * outcomes: 409 is only ever the `id` clash on create, 412 a Concurrent
 * Change. */
const EXPECTED_WRITE_FAILURES = new Map<number | undefined, 'conflict' | 'precondition-failed' | 'not-found'>([
  [409, 'conflict'],
  [412, 'precondition-failed'],
  [404, 'not-found']
])

function statusCodeOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

/** A failed point operation's RU charge exists only in its error headers. */
function errorRequestCharge(err: unknown): number {
  const headers = (err as { headers?: Record<string, unknown> } | null)?.headers
  const charge = Number(headers?.['x-ms-request-charge'])
  return Number.isFinite(charge) ? charge : 0
}

function stored(response: CosmosItemResponseLike): DocumentWriteResult {
  return {
    outcome: 'success',
    document: response.resource as StoredDocument,
    requestCharge: response.requestCharge
  }
}

/**
 * Refuses a create whose body would land at a different address than the
 * Document Write names: a body `id` other than the write's, or a partition
 * key level whose body value differs from the address (a missing property
 * is the None value `{}`). Paths are Cosmos partition key paths such as
 * `/customerId` or `/address/zip`.
 */
function assertBodyMatchesAddress(
  write: { id: string; partitionKey: PartitionKeyValue; body: object },
  partitionKeyPaths: string[]
): void {
  const body = write.body as Record<string, unknown>
  if (body.id !== undefined && body.id !== write.id) {
    throw new Error(`The document's id doesn't match the address "${write.id}".`)
  }
  const levels = Array.isArray(write.partitionKey) ? write.partitionKey : [write.partitionKey]
  partitionKeyPaths.forEach((path, index) => {
    const expected = levels[index]
    const actual = valueAtPath(body, path)
    const matches =
      expected !== null && typeof expected === 'object'
        ? actual === undefined
        : actual === expected
    if (!matches) {
      throw new Error(`The document's ${path} doesn't match the partition key value it is addressed by.`)
    }
  })
}

function valueAtPath(document: Record<string, unknown>, path: string): unknown {
  let current: unknown = document
  for (const segment of path.split('/').filter(Boolean)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Copies only the fields the SDK patch operation needs, so nothing else
 * riding on a Document Write's operation reaches the wire. */
function toSdkPatchOperation(operation: DocumentPatchOperation): CosmosPatchOperationLike {
  return operation.op === 'set'
    ? { op: 'set', path: operation.path, value: operation.value }
    : { op: 'remove', path: operation.path }
}

function requireCosmosConfig(profile: ConnectionProfile): CosmosConnectionConfig {
  if (profile.config.kind !== 'cosmos-db') {
    throw new Error(`CosmosDbProvider cannot handle connection kind "${profile.config.kind}"`)
  }
  return profile.config
}
