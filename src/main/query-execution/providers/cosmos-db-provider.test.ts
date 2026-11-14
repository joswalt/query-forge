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
  CosmosDatabaseLike,
  CosmosItemOptionsLike,
  CosmosItemResponseLike
} from './cosmos-db-provider'
import type { DocumentWrite, PartitionKeyValue } from '@shared/types/document-writer'
import type { ResultChunk } from '@shared/types/database-provider'

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
  readAllContainers: Array<{ id: string; partitionKey?: { paths?: string[] } }> = []
  containerPartitionKeyPaths: string[] = ['/partitionKey']
  queryPages: Array<{ resources: unknown[]; requestCharge: number; hasMoreResults?: boolean }> =
    []
  pagesServed = 0
  lastQuery: { query: string; abortSignal?: AbortSignal } | undefined
  lastTarget: { database: string; container: string } | undefined
  containerReads = 0
  containerReadError: Error | undefined
  /** Every SDK point operation, as the Provider called it. */
  readonly pointOps: PointOp[] = []
  /** What the next point operation resolves to (or throws). */
  pointOpResponse: CosmosItemResponseLike = { resource: { id: 'doc-1', _etag: '"2"' }, requestCharge: 6.2 }
  pointOpError: unknown

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
        read: async () => {
          this.containerReads++
          if (this.containerReadError) throw this.containerReadError
          return { resource: { partitionKey: { paths: this.containerPartitionKeyPaths } } }
        },
        item: (itemId: string, partitionKey: PartitionKeyValue) => {
          const record = (op: PointOp['op'], options?: CosmosItemOptionsLike, body?: unknown) =>
            this.pointOp({ op, database: id, container: containerId, id: itemId, partitionKey, body, options })
          return {
            read: (options) => record('read', options),
            replace: (body, options) => record('replace', options, body),
            patch: (body, options) => record('patch', options, body),
            delete: (options) => record('delete', options)
          }
        },
        items: {
          create: (body, options) =>
            this.pointOp({ op: 'create', database: id, container: containerId, body, options }),
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

  private async pointOp(op: PointOp): Promise<CosmosItemResponseLike> {
    this.pointOps.push(op)
    if (this.pointOpError) throw this.pointOpError
    return this.pointOpResponse
  }
}

interface PointOp {
  op: 'create' | 'read' | 'replace' | 'patch' | 'delete'
  database: string
  container: string
  id?: string
  partitionKey?: PartitionKeyValue
  body?: unknown
  options?: CosmosItemOptionsLike
}

/** The shape `@azure/cosmos` throws for a failed point operation: numeric
 * `code`, and the RU charge only in the response headers. */
function cosmosError(code: number, requestCharge: string): Error {
  return Object.assign(new Error(`Status ${code}`), {
    code,
    headers: { 'x-ms-request-charge': requestCharge }
  })
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
      client.readAllContainers = [
        { id: 'orders', partitionKey: { paths: ['/customerId'] } },
        { id: 'customers', partitionKey: { paths: ['/tenant', '/region'] } }
      ]
      const provider = new CosmosDbProvider(makeFactory(client))
      const profile = makeProfile({ ...baseConfig, container: undefined })

      await provider.connect(profile, 'secret')
      const metadata = await provider.getMetadata()

      expect(metadata.objects).toEqual([
        {
          name: 'orders',
          kind: 'container',
          database: 'orders-db',
          children: [{ name: '/customerId', kind: 'partition-key' }]
        },
        {
          name: 'customers',
          kind: 'container',
          database: 'orders-db',
          children: [
            { name: '/tenant', kind: 'partition-key' },
            { name: '/region', kind: 'partition-key' }
          ]
        }
      ])
    })

    it('lists every database with its containers when the profile is account-scoped', async () => {
      const client = new FakeCosmosClient()
      client.readAllDatabases = [{ id: 'orders-db' }]
      client.readAllContainers = [{ id: 'orders', partitionKey: { paths: ['/customerId'] } }]
      const provider = new CosmosDbProvider(makeFactory(client))
      const profile = makeProfile({ ...baseConfig, database: undefined, container: undefined })

      await provider.connect(profile, 'secret')
      const metadata = await provider.getMetadata()

      expect(metadata.objects).toEqual([
        {
          name: 'orders-db',
          kind: 'database',
          children: [
            {
              name: 'orders',
              kind: 'container',
              database: 'orders-db',
              children: [{ name: '/customerId', kind: 'partition-key' }]
            }
          ]
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
        { rows: [{ id: '1' }], meta: { ru: 2.1, partitionKeyPaths: ['/partitionKey'] } },
        { rows: [{ id: '2' }], meta: { ru: 1.4 } }
      ])
    })

    describe('partition key paths', () => {
      async function drain(provider: CosmosDbProvider, options = {}): Promise<ResultChunk[]> {
        const chunks: ResultChunk[] = []
        for await (const chunk of provider.executeQuery('SELECT * FROM c', options)) chunks.push(chunk)
        return chunks
      }

      it("carries the container's partition key paths on the first Result Chunk only", async () => {
        const client = new FakeCosmosClient()
        client.containerPartitionKeyPaths = ['/tenant', '/region']
        client.queryPages = [
          { resources: [{ id: '1' }], requestCharge: 2 },
          { resources: [{ id: '2' }], requestCharge: 1 }
        ]
        const provider = new CosmosDbProvider(makeFactory(client))
        await provider.connect(makeProfile(baseConfig), 'secret')

        expect(await drain(provider)).toEqual([
          { rows: [{ id: '1' }], meta: { ru: 2, partitionKeyPaths: ['/tenant', '/region'] } },
          { rows: [{ id: '2' }], meta: { ru: 1 } }
        ])
      })

      it('reads the container definition once per database/container and again after disconnect', async () => {
        const client = new FakeCosmosClient()
        client.queryPages = [{ resources: [], requestCharge: 1 }]
        const provider = new CosmosDbProvider(makeFactory(client))
        await provider.connect(makeProfile(baseConfig), 'secret')

        await drain(provider)
        await drain(provider)
        expect(client.containerReads).toBe(1)

        await drain(provider, { container: 'customers' })
        expect(client.containerReads).toBe(2)

        await provider.disconnect()
        await provider.connect(makeProfile(baseConfig), 'secret')
        const [first] = await drain(provider)
        expect(client.containerReads).toBe(3)
        expect(first.meta?.partitionKeyPaths).toEqual(['/partitionKey'])
      })

      it('still streams the query, with no partition key paths, when the container definition cannot be read', async () => {
        const client = new FakeCosmosClient()
        client.containerReadError = new Error('Forbidden')
        client.queryPages = [{ resources: [{ id: '1' }], requestCharge: 2 }]
        const provider = new CosmosDbProvider(makeFactory(client))
        await provider.connect(makeProfile(baseConfig), 'secret')

        expect(await drain(provider)).toEqual([{ rows: [{ id: '1' }], meta: { ru: 2 } }])
      })
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
          { rows: [{ id: '1' }, { id: '2' }], meta: { ru: 1, partitionKeyPaths: ['/partitionKey'] } },
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

        expect(chunks).toEqual([
          {
            rows: [{ id: '1' }, { id: '2' }],
            meta: { ru: 1, truncated: true, partitionKeyPaths: ['/partitionKey'] }
          }
        ])
        expect(client.pagesServed).toBe(1)
      })

      it('does not flag truncated when the results end exactly at the limit', async () => {
        const client = new FakeCosmosClient()
        client.queryPages = [
          { resources: [{ id: '1' }, { id: '2' }], requestCharge: 1, hasMoreResults: false }
        ]

        const chunks = await run(client, 2)

        expect(chunks).toEqual([
          { rows: [{ id: '1' }, { id: '2' }], meta: { ru: 1, partitionKeyPaths: ['/partitionKey'] } }
        ])
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

describe('CosmosDbProvider as a DocumentWriter', () => {
  async function connected(client: FakeCosmosClient): Promise<CosmosDbProvider> {
    const provider = new CosmosDbProvider(makeFactory(client))
    await provider.connect(makeProfile(baseConfig), 'secret')
    return provider
  }

  describe('replace', () => {
    it('addresses the document with its explicit partition key and an exact "IfMatch" access condition', async () => {
      const client = new FakeCosmosClient()
      const provider = await connected(client)

      const result = await provider.writeDocument({
        kind: 'replace',
        id: 'doc-1',
        partitionKey: 'cust-1',
        body: { id: 'doc-1', partitionKey: 'cust-1', total: 5 },
        ifMatch: '"1"'
      })

      expect(client.pointOps).toEqual([
        {
          op: 'replace',
          database: 'orders-db',
          container: 'orders',
          id: 'doc-1',
          partitionKey: 'cust-1',
          body: { id: 'doc-1', partitionKey: 'cust-1', total: 5 },
          options: { accessCondition: { type: 'IfMatch', condition: '"1"' } }
        }
      ])
      expect(result).toEqual({
        outcome: 'success',
        document: { id: 'doc-1', _etag: '"2"' },
        requestCharge: 6.2
      })
    })
  })

  describe('create', () => {
    it('always sends an explicit id and returns the stored document', async () => {
      const client = new FakeCosmosClient()
      client.containerPartitionKeyPaths = ['/customerId']
      const provider = await connected(client)

      const result = await provider.writeDocument({
        kind: 'create',
        id: 'new-1',
        partitionKey: 'cust-1',
        body: { customerId: 'cust-1', total: 5 }
      })

      expect(client.pointOps).toEqual([
        {
          op: 'create',
          database: 'orders-db',
          container: 'orders',
          body: { customerId: 'cust-1', total: 5, id: 'new-1' },
          options: {}
        }
      ])
      expect(result).toEqual({
        outcome: 'success',
        document: { id: 'doc-1', _etag: '"2"' },
        requestCharge: 6.2
      })
    })

    it('accepts a body that leaves out a None level of a hierarchical partition key', async () => {
      const client = new FakeCosmosClient()
      client.containerPartitionKeyPaths = ['/tenant', '/region/code']
      const provider = await connected(client)

      await provider.writeDocument({
        kind: 'create',
        id: 'new-1',
        partitionKey: ['tenant-a', {}],
        body: { tenant: 'tenant-a', region: {} }
      })

      expect(client.pointOps).toHaveLength(1)
    })

    it.each<[string, object, PartitionKeyValue]>([
      ['a different partition key value', { customerId: 'cust-2' }, 'cust-1'],
      ['a value where the address says None', { customerId: 'cust-1' }, {}],
      ['no value where the address says null', {}, null],
      ['a different id', { id: 'other', customerId: 'cust-1' }, 'cust-1']
    ])('refuses a body with %s without calling the SDK', async (_label, body, partitionKey) => {
      const client = new FakeCosmosClient()
      client.containerPartitionKeyPaths = ['/customerId']
      const provider = await connected(client)

      await expect(
        provider.writeDocument({ kind: 'create', id: 'new-1', partitionKey, body })
      ).rejects.toThrow("doesn't match")
      expect(client.pointOps).toEqual([])
    })
  })

  describe('delete', () => {
    it.each<[string, PartitionKeyValue]>([
      ['a JSON null partition key', null],
      ['the None partition key', {}],
      ['a hierarchical partition key with a None level', ['tenant-a', 7, {}]]
    ])('passes %s explicitly with "IfMatch" and returns no document', async (_label, partitionKey) => {
      const client = new FakeCosmosClient()
      client.pointOpResponse = { resource: undefined, requestCharge: 5.1 }
      const provider = await connected(client)

      const result = await provider.writeDocument({
        kind: 'delete',
        id: 'doc-1',
        partitionKey,
        ifMatch: '"1"'
      })

      expect(client.pointOps).toEqual([
        {
          op: 'delete',
          database: 'orders-db',
          container: 'orders',
          id: 'doc-1',
          partitionKey,
          body: undefined,
          options: { accessCondition: { type: 'IfMatch', condition: '"1"' } }
        }
      ])
      expect(result).toEqual({ outcome: 'success', requestCharge: 5.1 })
    })
  })

  describe('patch', () => {
    it('maps set and remove to SDK patch operations under an exact "IfMatch"', async () => {
      const client = new FakeCosmosClient()
      const provider = await connected(client)

      const result = await provider.writeDocument({
        kind: 'patch',
        id: 'doc-1',
        partitionKey: ['tenant-a', null],
        ifMatch: '"1"',
        operations: [
          { op: 'set', path: '/status', value: 'shipped' },
          { op: 'remove', path: '/legacy/flag' }
        ]
      })

      expect(client.pointOps).toEqual([
        {
          op: 'patch',
          database: 'orders-db',
          container: 'orders',
          id: 'doc-1',
          partitionKey: ['tenant-a', null],
          body: {
            operations: [
              { op: 'set', path: '/status', value: 'shipped' },
              { op: 'remove', path: '/legacy/flag' }
            ]
          },
          options: { accessCondition: { type: 'IfMatch', condition: '"1"' } }
        }
      ])
      expect(result).toEqual({
        outcome: 'success',
        document: { id: 'doc-1', _etag: '"2"' },
        requestCharge: 6.2
      })
    })

    it('refuses more than 10 operations without calling the SDK', async () => {
      const client = new FakeCosmosClient()
      const provider = await connected(client)
      const operations = Array.from({ length: 11 }, (_, i) => ({
        op: 'set' as const,
        path: `/p${i}`,
        value: i
      }))

      await expect(
        provider.writeDocument({ kind: 'patch', id: 'doc-1', partitionKey: 'cust-1', ifMatch: '"1"', operations })
      ).rejects.toThrow('10')
      expect(client.pointOps).toEqual([])
    })
  })

  describe('expected failures', () => {
    it.each<[string, number, DocumentWrite, string]>([
      [
        'an id clash on create is a conflict',
        409,
        { kind: 'create', id: 'doc-1', partitionKey: 'cust-1', body: { partitionKey: 'cust-1' } },
        'conflict'
      ],
      [
        'a Concurrent Change on replace is precondition-failed',
        412,
        { kind: 'replace', id: 'doc-1', partitionKey: 'cust-1', body: {}, ifMatch: '"1"' },
        'precondition-failed'
      ],
      [
        'a Concurrent Change on patch is precondition-failed',
        412,
        { kind: 'patch', id: 'doc-1', partitionKey: 'cust-1', ifMatch: '"1"', operations: [] },
        'precondition-failed'
      ],
      [
        'a missing document on delete is not-found',
        404,
        { kind: 'delete', id: 'doc-1', partitionKey: 'cust-1', ifMatch: '"1"' },
        'not-found'
      ]
    ])('%s, with the RU charge read from the error headers', async (_label, code, write, outcome) => {
      const client = new FakeCosmosClient()
      client.pointOpError = cosmosError(code, '1.24')
      const provider = await connected(client)

      expect(await provider.writeDocument(write)).toEqual({ outcome, requestCharge: 1.24 })
    })

    it('throws anything else so it takes the scrubbed-message path', async () => {
      const client = new FakeCosmosClient()
      client.pointOpError = cosmosError(400, '1')
      const provider = await connected(client)

      await expect(
        provider.writeDocument({ kind: 'delete', id: 'doc-1', partitionKey: 'cust-1', ifMatch: '"1"' })
      ).rejects.toThrow('Status 400')
    })
  })

  describe('readDocument', () => {
    it('point-reads the document with its explicit partition key, without an access condition', async () => {
      const client = new FakeCosmosClient()
      client.pointOpResponse = { resource: { id: 'doc-1', _etag: '"1"' }, requestCharge: 1 }
      const provider = await connected(client)

      const result = await provider.readDocument({
        id: 'doc-1',
        partitionKey: [null, {}],
        database: 'other-db',
        container: 'other'
      })

      expect(client.pointOps).toEqual([
        {
          op: 'read',
          database: 'other-db',
          container: 'other',
          id: 'doc-1',
          partitionKey: [null, {}],
          body: undefined,
          options: undefined
        }
      ])
      expect(result).toEqual({
        outcome: 'success',
        document: { id: 'doc-1', _etag: '"1"' },
        requestCharge: 1
      })
    })

    it("maps the SDK's undefined resource (its 404) to not-found", async () => {
      const client = new FakeCosmosClient()
      client.pointOpResponse = { resource: undefined, requestCharge: 1.1 }
      const provider = await connected(client)

      expect(await provider.readDocument({ id: 'gone', partitionKey: 'cust-1' })).toEqual({
        outcome: 'not-found',
        requestCharge: 1.1
      })
    })
  })

  it('sends a Document Write at low priority when asked (for DML Statement runs)', async () => {
    const client = new FakeCosmosClient()
    const provider = await connected(client)

    await provider.writeDocument(
      { kind: 'delete', id: 'doc-1', partitionKey: 'cust-1', ifMatch: '"1"' },
      { priorityLevel: 'Low' }
    )

    expect(client.pointOps[0].options).toEqual({
      accessCondition: { type: 'IfMatch', condition: '"1"' },
      priorityLevel: 'Low'
    })
  })
})
