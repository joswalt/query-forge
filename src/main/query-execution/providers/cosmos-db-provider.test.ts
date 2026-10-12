import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, CosmosConnectionConfig } from '@shared/types/connection-profile'
import {
  buildCosmosConnectionPolicy,
  COSMOS_RETRY_OPTIONS,
  CosmosDbProvider
} from './cosmos-db-provider'
import type {
  CosmosClientFactory,
  CosmosClientFactoryOptions,
  CosmosClientLike,
  CosmosContainerLike,
  CosmosDatabaseLike
} from './cosmos-db-provider'

function makeProfile(config: CosmosConnectionConfig): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Test Cosmos',
    readOnly: false,
    config,
    hasSecret: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

/** A fake CosmosClientLike that records calls and lets each test control
 * what `read()`/`query()` return or throw, without mocking the real SDK. */
class FakeCosmosClient implements CosmosClientLike {
  disposed = false
  readonly databaseReads: string[] = []
  databaseReadError: Error | undefined
  readAllDatabases: Array<{ id: string }> = []
  readAllContainers: Array<{ id: string }> = []
  containerPartitionKeyPaths: string[] = ['/partitionKey']
  queryPages: Array<{ resources: unknown[]; requestCharge: number; hasMoreResults?: boolean }> =
    []
  pagesServed = 0
  lastQuery: { query: string; abortSignal?: AbortSignal } | undefined
  lastTarget: { database: string; container: string } | undefined

  readonly databases = {
    readAll: () => ({
      fetchAll: async (): Promise<{ resources: Array<{ id: string }> }> => ({
        resources: this.readAllDatabases
      })
    })
  }

  database(id: string): CosmosDatabaseLike {
    return {
      read: async () => {
        this.databaseReads.push(id)
        if (this.databaseReadError) throw this.databaseReadError
        return {}
      },
      containers: {
        readAll: () => ({
          fetchAll: async () => ({ resources: this.readAllContainers })
        })
      },
      container: (containerId: string): CosmosContainerLike => ({
        read: async () => ({
          resource: { partitionKey: { paths: this.containerPartitionKeyPaths } }
        }),
        items: {
          query: (query: string, options?: { abortSignal?: AbortSignal }) => {
            this.lastQuery = { query, abortSignal: options?.abortSignal }
            this.lastTarget = { database: id, container: containerId }
            const pages = this.queryPages
            const onServed = (): void => {
              this.pagesServed++
            }
            return {
              getAsyncIterator: async function* () {
                for (const page of pages) {
                  if (options?.abortSignal?.aborted) return
                  onServed()
                  yield page
                }
              }
            }
          }
        }
      })
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

function makeFactory(client: FakeCosmosClient): CosmosClientFactory {
  return () => client
}

const baseConfig: CosmosConnectionConfig = {
  kind: 'cosmos-db',
  endpoint: 'https://example.documents.azure.com',
  authMode: 'account-key',
  database: 'orders-db',
  container: 'orders'
}

describe('CosmosDbProvider', () => {
  describe('testConnection', () => {
    it('succeeds without populating the live client when the database is reachable', async () => {
      const client = new FakeCosmosClient()
      const provider = new CosmosDbProvider(makeFactory(client))

      const result = await provider.testConnection(makeProfile(baseConfig), 'account-key-secret')

      expect(result).toEqual({ success: true })
      expect(client.databaseReads).toEqual(['orders-db'])
      expect(client.disposed).toBe(true)
      // Not populating the live pool means getMetadata() still fails — no
      // connect() was called.
      await expect(provider.getMetadata()).rejects.toThrow('not connected')
    })

    it('reports failure with a safe (scrubbed) message when the database read fails', async () => {
      const client = new FakeCosmosClient()
      client.databaseReadError = new Error('Unauthorized: key=super-secret-key')
      const provider = new CosmosDbProvider(makeFactory(client))

      const result = await provider.testConnection(makeProfile(baseConfig), 'bad-secret')

      expect(result.success).toBe(false)
      expect(result.message).toBe('Unauthorized: key=***')
    })

    it('tests an entra-id connection using aadCredentials, not an account key', async () => {
      const client = new FakeCosmosClient()
      let capturedOptions: CosmosClientFactoryOptions | undefined
      const factory: CosmosClientFactory = (options) => {
        capturedOptions = options
        return client
      }
      const provider = new CosmosDbProvider(factory)
      const profile = makeProfile({ ...baseConfig, authMode: 'entra-id' })

      const result = await provider.testConnection(profile, 'aad-access-token')

      expect(result).toEqual({ success: true })
      expect(capturedOptions?.key).toBeUndefined()
      expect(await capturedOptions?.aadCredentials?.getToken([])).toMatchObject({
        token: 'aad-access-token'
      })
    })
  })

  describe('connect + getMetadata', () => {
    it('lists containers when the profile has a database but no container', async () => {
      const client = new FakeCosmosClient()
      client.readAllContainers = [{ id: 'orders' }, { id: 'customers' }]
      const provider = new CosmosDbProvider(makeFactory(client))
      const profile = makeProfile({ ...baseConfig, container: undefined })

      await provider.connect(profile, 'secret')
      const metadata = await provider.getMetadata()

      expect(metadata.objects).toEqual([
        { name: 'orders', kind: 'container', database: 'orders-db' },
        { name: 'customers', kind: 'container', database: 'orders-db' }
      ])
    })

    it('lists every database with its containers when the profile is account-scoped', async () => {
      const client = new FakeCosmosClient()
      client.readAllDatabases = [{ id: 'orders-db' }]
      client.readAllContainers = [{ id: 'orders' }]
      const provider = new CosmosDbProvider(makeFactory(client))
      const profile = makeProfile({ ...baseConfig, database: undefined, container: undefined })

      await provider.connect(profile, 'secret')
      const metadata = await provider.getMetadata()

      expect(metadata.objects).toEqual([
        {
          name: 'orders-db',
          kind: 'database',
          children: [{ name: 'orders', kind: 'container', database: 'orders-db' }]
        }
      ])
    })

    it('returns the container with its partition key paths as children when fully scoped', async () => {
      const client = new FakeCosmosClient()
      client.containerPartitionKeyPaths = ['/customerId']
      const provider = new CosmosDbProvider(makeFactory(client))

      await provider.connect(makeProfile(baseConfig), 'secret')
      const metadata = await provider.getMetadata()

      expect(metadata.objects).toEqual([
        {
          name: 'orders',
          kind: 'container',
          database: 'orders-db',
          children: [{ name: '/customerId', kind: 'partition-key' }]
        }
      ])
    })

    it('connects an entra-id profile using aadCredentials wrapping the access token', async () => {
      const client = new FakeCosmosClient()
      let capturedOptions: CosmosClientFactoryOptions | undefined
      const factory: CosmosClientFactory = (options) => {
        capturedOptions = options
        return client
      }
      const provider = new CosmosDbProvider(factory)
      const profile = makeProfile({ ...baseConfig, authMode: 'entra-id' })

      await provider.connect(profile, 'aad-access-token')

      expect(capturedOptions?.key).toBeUndefined()
      expect(await capturedOptions?.aadCredentials?.getToken([])).toMatchObject({
        token: 'aad-access-token'
      })
    })
  })

  describe('entra-id token renewal', () => {
    it('renews the token through the refresher once the connect() token has expired', async () => {
      let capturedOptions: CosmosClientFactoryOptions | undefined
      const provider = new CosmosDbProvider((options) => {
        capturedOptions = options
        return new FakeCosmosClient()
      })
      const expired = `h.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.s`
      const refresh = vi.fn(async () => 'renewed-token')

      await provider.connect(makeProfile({ ...baseConfig, authMode: 'entra-id' }), expired, refresh)

      expect(await capturedOptions?.aadCredentials?.getToken([])).toMatchObject({
        token: 'renewed-token'
      })
      expect(refresh).toHaveBeenCalledTimes(1)
    })
  })

  describe('executeQuery', () => {
    it('lets QueryOptions override the profile\'s database and container', async () => {
      const client = new FakeCosmosClient()
      client.queryPages = [{ resources: [], requestCharge: 1 }]
      const provider = new CosmosDbProvider(makeFactory(client))
      await provider.connect(
        makeProfile({ ...baseConfig, database: undefined, container: undefined }),
        'secret'
      )

      for await (const _chunk of provider.executeQuery('SELECT * FROM c', {
        database: 'other-db',
        container: 'other'
      })) {
        // drain
      }

      expect(client.lastTarget).toEqual({ database: 'other-db', container: 'other' })
    })

    it('streams each page as a Result Chunk carrying the RU charge', async () => {
      const client = new FakeCosmosClient()
      client.queryPages = [
        { resources: [{ id: '1' }], requestCharge: 2.1 },
        { resources: [{ id: '2' }], requestCharge: 1.4 }
      ]
      const provider = new CosmosDbProvider(makeFactory(client))
      await provider.connect(makeProfile(baseConfig), 'secret')

      const chunks = []
      for await (const chunk of provider.executeQuery('SELECT * FROM c')) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([
        { rows: [{ id: '1' }], meta: { ru: 2.1 } },
        { rows: [{ id: '2' }], meta: { ru: 1.4 } }
      ])
    })

    describe('maxRows', () => {
      async function run(
        client: FakeCosmosClient,
        maxRows: number | undefined
      ): Promise<Awaited<ReturnType<typeof collectChunks>>> {
        const provider = new CosmosDbProvider(makeFactory(client))
        await provider.connect(makeProfile(baseConfig), 'secret')
        return collectChunks(provider.executeQuery('SELECT * FROM c', { maxRows }))
      }
      async function collectChunks(
        iterable: AsyncIterable<{ rows: unknown[]; meta?: { ru?: number; truncated?: boolean } }>
      ): Promise<Array<{ rows: unknown[]; meta?: { ru?: number; truncated?: boolean } }>> {
        const chunks = []
        for await (const chunk of iterable) chunks.push(chunk)
        return chunks
      }

      it('slices the page that crosses the limit, flags truncated, and fetches no further pages', async () => {
        const client = new FakeCosmosClient()
        client.queryPages = [
          { resources: [{ id: '1' }, { id: '2' }], requestCharge: 1, hasMoreResults: true },
          { resources: [{ id: '3' }, { id: '4' }], requestCharge: 1, hasMoreResults: true },
          { resources: [{ id: '5' }], requestCharge: 1, hasMoreResults: false }
        ]

        const chunks = await run(client, 3)

        expect(chunks).toEqual([
          { rows: [{ id: '1' }, { id: '2' }], meta: { ru: 1 } },
          { rows: [{ id: '3' }], meta: { ru: 1, truncated: true } }
        ])
        expect(client.pagesServed).toBe(2)
      })

      it('flags truncated when the limit lands exactly on a page boundary with more to come', async () => {
        const client = new FakeCosmosClient()
        client.queryPages = [
          { resources: [{ id: '1' }, { id: '2' }], requestCharge: 1, hasMoreResults: true },
          { resources: [{ id: '3' }], requestCharge: 1, hasMoreResults: false }
        ]

        const chunks = await run(client, 2)

        expect(chunks).toEqual([{ rows: [{ id: '1' }, { id: '2' }], meta: { ru: 1, truncated: true } }])
        expect(client.pagesServed).toBe(1)
      })

      it('does not flag truncated when the results end exactly at the limit', async () => {
        const client = new FakeCosmosClient()
        client.queryPages = [
          { resources: [{ id: '1' }, { id: '2' }], requestCharge: 1, hasMoreResults: false }
        ]

        const chunks = await run(client, 2)

        expect(chunks).toEqual([{ rows: [{ id: '1' }, { id: '2' }], meta: { ru: 1 } }])
      })

      it('runs to completion when maxRows is omitted', async () => {
        const client = new FakeCosmosClient()
        client.queryPages = [
          { resources: [{ id: '1' }], requestCharge: 1, hasMoreResults: true },
          { resources: [{ id: '2' }], requestCharge: 1, hasMoreResults: true },
          { resources: [{ id: '3' }], requestCharge: 1, hasMoreResults: false }
        ]

        const chunks = await run(client, undefined)

        expect(chunks).toHaveLength(3)
        expect(chunks.some((c) => c.meta?.truncated)).toBe(false)
        expect(client.pagesServed).toBe(3)
      })
    })

    it('cancel() aborts the in-flight query via AbortSignal (client-side abandonment only)', async () => {
      const client = new FakeCosmosClient()
      client.queryPages = [
        { resources: [{ id: '1' }], requestCharge: 1 },
        { resources: [{ id: '2' }], requestCharge: 1 },
        { resources: [{ id: '3' }], requestCharge: 1 }
      ]
      const provider = new CosmosDbProvider(makeFactory(client))
      await provider.connect(makeProfile(baseConfig), 'secret')

      const chunks = []
      for await (const chunk of provider.executeQuery('SELECT * FROM c', { executionId: 'exec-1' })) {
        chunks.push(chunk)
        if (chunks.length === 1) provider.cancel('exec-1')
      }

      // The second page's abortSignal.aborted check short-circuits the
      // fake's generator — fewer than all 3 pages come through.
      expect(chunks.length).toBeLessThan(3)
    })
  })
})

describe('buildCosmosConnectionPolicy', () => {
  // Regression: with endpoint discovery on, an unreachable host made the
  // SDK retry for 60s+, ignoring requestTimeout and AbortSignal.
  it('disables endpoint discovery so an unreachable host fails fast', () => {
    expect(buildCosmosConnectionPolicy(undefined).enableEndpointDiscovery).toBe(false)
  })

  it('keeps the explicit 429 retry options', () => {
    expect(buildCosmosConnectionPolicy(5000).retryOptions).toEqual(COSMOS_RETRY_OPTIONS)
  })

  it('passes the profile timeout through as requestTimeout, and omits it when unset', () => {
    expect(buildCosmosConnectionPolicy(5000).requestTimeout).toBe(5000)
    expect('requestTimeout' in buildCosmosConnectionPolicy(undefined)).toBe(false)
  })
})
