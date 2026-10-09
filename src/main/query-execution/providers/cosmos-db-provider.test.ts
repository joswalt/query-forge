import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, CosmosConnectionConfig } from '@shared/types/connection-profile'
import { CosmosDbProvider } from './cosmos-db-provider'
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
  queryPages: Array<{ resources: unknown[]; requestCharge: number }> = []
  lastQuery: { query: string; abortSignal?: AbortSignal } | undefined

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
      container: (_containerId: string): CosmosContainerLike => ({
        read: async () => ({
          resource: { partitionKey: { paths: this.containerPartitionKeyPaths } }
        }),
        items: {
          query: (query: string, options?: { abortSignal?: AbortSignal }) => {
            this.lastQuery = { query, abortSignal: options?.abortSignal }
            const pages = this.queryPages
            return {
              getAsyncIterator: async function* () {
                for (const page of pages) {
                  if (options?.abortSignal?.aborted) return
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
        { name: 'orders', kind: 'container' },
        { name: 'customers', kind: 'container' }
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

  describe('executeQuery', () => {
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
