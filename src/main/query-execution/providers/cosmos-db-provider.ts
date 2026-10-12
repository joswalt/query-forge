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
    readAll(): { fetchAll(): Promise<{ resources: Array<{ id: string }> }> }
  }
}

export interface CosmosFeedResponseLike {
  resources: unknown[]
  requestCharge: number
  /** `FeedResponse.hasMoreResults` — true while a continuation token remains. */
  hasMoreResults?: boolean
}

export interface CosmosContainerLike {
  read(): Promise<{ resource?: { partitionKey?: { paths?: string[] } } }>
  readonly items: {
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
export class CosmosDbProvider implements DatabaseProvider {
  private client: CosmosClientLike | undefined
  private config: CosmosConnectionConfig | undefined
  private readonly abortControllers = new Map<ExecutionId, AbortController>()

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
        yield {
          rows,
          meta: { ru: page.requestCharge, ...(truncated ? { truncated: true } : {}) }
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
          children: containers.map(
            (c): DatabaseMetadataObject => ({ name: c.id, kind: 'container', database: d.id })
          )
        })
      }
      return { objects }
    }

    const database = this.client.database(this.config.database)

    if (!this.config.container) {
      const { resources } = await database.containers.readAll().fetchAll()
      return {
        objects: resources.map(
          (c): DatabaseMetadataObject => ({
            name: c.id,
            kind: 'container',
            database: this.config?.database
          })
        )
      }
    }

    const container = this.requireContainer()
    const { resource } = await container.read()
    const partitionKeyPaths = resource?.partitionKey?.paths ?? []

    return {
      objects: [
        {
          name: this.config.container,
          kind: 'container',
          database: this.config.database,
          children: partitionKeyPaths.map((path): DatabaseMetadataObject => ({
            name: path,
            kind: 'partition-key'
          }))
        }
      ]
    }
  }

  /** Centralizes the "connected, with database + container configured"
   * precondition that both `executeQuery` and `getMetadata`'s fully-scoped
   * branch need, rather than repeating the `client.database(...).container(...)`
   * chain at each call site. */
  private requireContainer(options?: QueryOptions): CosmosContainerLike {
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

function requireCosmosConfig(profile: ConnectionProfile): CosmosConnectionConfig {
  if (profile.config.kind !== 'cosmos-db') {
    throw new Error(`CosmosDbProvider cannot handle connection kind "${profile.config.kind}"`)
  }
  return profile.config
}
