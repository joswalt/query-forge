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
  TestResult
} from '@shared/types/database-provider'
import { UnsupportedAuthModeError } from '@shared/types/database-provider'
import { toSafeErrorMessage } from '../scrub-error-message'

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

export type CosmosClientFactory = (options: { endpoint: string; key?: string }) => CosmosClientLike

const defaultClientFactory: CosmosClientFactory = ({ endpoint, key }) =>
  new CosmosClient({ endpoint, key }) as unknown as CosmosClientLike

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

  async connect(profile: ConnectionProfile, secret: DecryptedSecret | undefined): Promise<void> {
    const config = requireCosmosConfig(profile)
    assertSupportedAuthMode(config.authMode)
    // CosmosClient's constructor performs no network I/O — connect() is
    // lazy by design (unlike Azure SQL's eager pool.connect()).
    this.client = this.clientFactory({ endpoint: config.endpoint, key: secret })
    this.config = config
  }

  async testConnection(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined
  ): Promise<TestResult> {
    const config = requireCosmosConfig(profile)
    try {
      assertSupportedAuthMode(config.authMode)
    } catch (err) {
      return { success: false, message: toSafeErrorMessage(err) }
    }

    // Test Connection (GLOSSARY.md) never populates the live pool — a
    // throwaway client, never assigned to `this.client`.
    const client = this.clientFactory({ endpoint: config.endpoint, key: secret })
    try {
      if (config.database) {
        await client.database(config.database).read()
      } else {
        await client.databases.readAll().fetchAll()
      }
      return { success: true }
    } catch (err) {
      return { success: false, message: toSafeErrorMessage(err) }
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
    const container = this.requireContainer()

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

      for await (const page of iterator) {
        yield { rows: page.resources, meta: { ru: page.requestCharge } }
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
      const { resources } = await this.client.databases.readAll().fetchAll()
      return { objects: resources.map((d): DatabaseMetadataObject => ({ name: d.id, kind: 'database' })) }
    }

    const database = this.client.database(this.config.database)

    if (!this.config.container) {
      const { resources } = await database.containers.readAll().fetchAll()
      return { objects: resources.map((c): DatabaseMetadataObject => ({ name: c.id, kind: 'container' })) }
    }

    const container = this.requireContainer()
    const { resource } = await container.read()
    const partitionKeyPaths = resource?.partitionKey?.paths ?? []

    return {
      objects: [
        {
          name: this.config.container,
          kind: 'container',
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
  private requireContainer(): CosmosContainerLike {
    if (!this.client || !this.config?.database || !this.config.container) {
      throw new Error('Cosmos DB Provider requires a connected database and container')
    }
    return this.client.database(this.config.database).container(this.config.container)
  }
}

function requireCosmosConfig(profile: ConnectionProfile): CosmosConnectionConfig {
  if (profile.config.kind !== 'cosmos-db') {
    throw new Error(`CosmosDbProvider cannot handle connection kind "${profile.config.kind}"`)
  }
  return profile.config
}

function assertSupportedAuthMode(authMode: CosmosConnectionConfig['authMode']): void {
  if (authMode !== 'account-key') {
    throw new UnsupportedAuthModeError(authMode)
  }
}
