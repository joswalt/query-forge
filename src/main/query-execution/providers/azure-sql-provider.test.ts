import { describe, expect, it } from 'vitest'
import type { AzureSqlConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'
import { AzureSqlProvider } from './azure-sql-provider'
import type { SqlConfig, SqlPoolFactory, SqlPoolLike, SqlRequestLike } from './azure-sql-provider'

function makeProfile(config: AzureSqlConnectionConfig): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Test SQL',
    readOnly: false,
    config,
    hasSecret: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

// Implementation signature only (never part of the public SqlRequestLike
// type) — loose enough to satisfy all three `on()` overloads below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void

/** A fake SqlRequestLike that lets a test script row/error/done events,
 * simulating mssql's streaming `Request` without mocking the real SDK. */
class FakeSqlRequest implements SqlRequestLike {
  stream = false
  canceled = false
  queriedWith: string | undefined
  private readonly listeners = new Map<string, Listener[]>()

  query(command: string): Promise<{ recordset?: Array<Record<string, unknown>> }> {
    this.queriedWith = command
    return Promise.resolve({ recordset: this.fixedRecordset })
  }

  fixedRecordset: Array<Record<string, unknown>> | undefined

  cancel(): void {
    this.canceled = true
    this.emit('done')
  }

  on(event: 'row', listener: (row: Record<string, unknown>) => void): this
  on(event: 'error', listener: (err: unknown) => void): this
  on(event: 'done', listener: () => void): this
  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeSqlPool implements SqlPoolLike {
  closed = false
  connectError: Error | undefined
  requests: FakeSqlRequest[] = []
  nextRequest: (() => FakeSqlRequest) | undefined

  async connect(): Promise<unknown> {
    if (this.connectError) throw this.connectError
    return this
  }

  async close(): Promise<void> {
    this.closed = true
  }

  request(): SqlRequestLike {
    const request = this.nextRequest ? this.nextRequest() : new FakeSqlRequest()
    this.requests.push(request as FakeSqlRequest)
    return request
  }
}

function makeFactory(pool: FakeSqlPool): SqlPoolFactory {
  return () => pool
}

const baseConfig: AzureSqlConnectionConfig = {
  kind: 'azure-sql',
  server: 'example.database.windows.net',
  database: 'orders',
  authMode: 'sql-credentials',
  username: 'app-user'
}

describe('AzureSqlProvider', () => {
  describe('testConnection', () => {
    it('succeeds and closes the throwaway pool without populating the live one', async () => {
      const pool = new FakeSqlPool()
      const provider = new AzureSqlProvider(makeFactory(pool))

      const result = await provider.testConnection(makeProfile(baseConfig), 'hunter2')

      expect(result).toEqual({ success: true })
      expect(pool.closed).toBe(true)
      await expect(provider.getMetadata()).rejects.toThrow('not connected')
    })

    it('reports failure with a safe (scrubbed) message when connect fails', async () => {
      const pool = new FakeSqlPool()
      pool.connectError = new Error('Login failed; password=hunter2;server=x')
      const provider = new AzureSqlProvider(makeFactory(pool))

      const result = await provider.testConnection(makeProfile(baseConfig), 'hunter2')

      expect(result.success).toBe(false)
      expect(result.message).toBe('Login failed; password=***;server=x')
    })

    it('tests an entra-id connection using an AAD access token, not a password', async () => {
      const pool = new FakeSqlPool()
      let capturedConfig: SqlConfig | undefined
      const factory: SqlPoolFactory = (config) => {
        capturedConfig = config
        return pool
      }
      const provider = new AzureSqlProvider(factory)
      const profile = makeProfile({ ...baseConfig, authMode: 'entra-id' })

      const result = await provider.testConnection(profile, 'aad-access-token')

      expect(result).toEqual({ success: true })
      expect(capturedConfig?.authentication).toEqual({
        type: 'azure-active-directory-access-token',
        options: { token: 'aad-access-token' }
      })
      expect(capturedConfig?.user).toBeUndefined()
      expect(capturedConfig?.password).toBeUndefined()
    })
  })

  describe('connect', () => {
    it('connects an entra-id profile using an AAD access token authentication block', async () => {
      const pool = new FakeSqlPool()
      let capturedConfig: SqlConfig | undefined
      const factory: SqlPoolFactory = (config) => {
        capturedConfig = config
        return pool
      }
      const provider = new AzureSqlProvider(factory)
      const profile = makeProfile({ ...baseConfig, authMode: 'entra-id' })

      await provider.connect(profile, 'aad-access-token')

      expect(capturedConfig?.authentication).toEqual({
        type: 'azure-active-directory-access-token',
        options: { token: 'aad-access-token' }
      })
    })

    it('maps profile config + secret into mssql config shape', async () => {
      const pool = new FakeSqlPool()
      let capturedConfig: SqlConfig | undefined
      const factory: SqlPoolFactory = (config) => {
        capturedConfig = config
        return pool
      }
      const provider = new AzureSqlProvider(factory)

      await provider.connect(
        makeProfile({ ...baseConfig, port: 1433, connectionTimeoutMs: 5000 }),
        'hunter2'
      )

      expect(capturedConfig).toMatchObject({
        server: 'example.database.windows.net',
        port: 1433,
        database: 'orders',
        user: 'app-user',
        password: 'hunter2',
        connectionTimeout: 5000
      })
    })
  })

  describe('executeQuery', () => {
    it('batches streamed rows into Result Chunks', async () => {
      const pool = new FakeSqlPool()
      const request = new FakeSqlRequest()
      pool.nextRequest = () => request
      const provider = new AzureSqlProvider(makeFactory(pool))
      await provider.connect(makeProfile(baseConfig), 'hunter2')

      const iterator = provider.executeQuery('SELECT * FROM orders')[Symbol.asyncIterator]()
      // Async generators run synchronously up to their first `await`, so
      // the pre-loop setup (request.on(...) listener registration) has
      // already happened by the time `.next()` returns a pending promise
      // — safe to emit events immediately after, in the same tick.
      const firstChunk = iterator.next()
      request.emit('row', { id: 1 })
      request.emit('row', { id: 2 })
      request.emit('done')

      const chunks = []
      let result = await firstChunk
      while (!result.done) {
        chunks.push(result.value)
        result = await iterator.next()
      }

      expect(chunks).toEqual([{ rows: [{ id: 1 }, { id: 2 }] }])
    })

    it('surfaces a scrubbed error from the error event', async () => {
      const pool = new FakeSqlPool()
      const request = new FakeSqlRequest()
      pool.nextRequest = () => request
      const provider = new AzureSqlProvider(makeFactory(pool))
      await provider.connect(makeProfile(baseConfig), 'hunter2')

      const iterator = provider.executeQuery('SELECT * FROM orders')[Symbol.asyncIterator]()
      const firstChunk = iterator.next()
      request.emit('error', new Error('Invalid column; password=hunter2'))

      await expect(firstChunk).rejects.toThrow('Invalid column; password=***')
    })

    it('cancel() calls Request.cancel() — genuine server-side cancellation, not mere abandonment', async () => {
      const pool = new FakeSqlPool()
      const request = new FakeSqlRequest()
      pool.nextRequest = () => request
      const provider = new AzureSqlProvider(makeFactory(pool))
      await provider.connect(makeProfile(baseConfig), 'hunter2')

      const iterator = provider.executeQuery('SELECT * FROM orders', { executionId: 'exec-1' })[
        Symbol.asyncIterator
      ]()
      const firstChunk = iterator.next()

      provider.cancel('exec-1')

      expect(request.canceled).toBe(true)
      await firstChunk
    })
  })

  describe('getMetadata', () => {
    it('groups columns into schema -> table -> column', async () => {
      const pool = new FakeSqlPool()
      const request = new FakeSqlRequest()
      request.fixedRecordset = [
        { schemaName: 'dbo', tableName: 'orders', columnName: 'id', dataType: 'int' },
        { schemaName: 'dbo', tableName: 'orders', columnName: 'total', dataType: 'decimal' },
        { schemaName: 'dbo', tableName: 'customers', columnName: 'id', dataType: 'int' }
      ]
      pool.nextRequest = () => request
      const provider = new AzureSqlProvider(makeFactory(pool))
      await provider.connect(makeProfile(baseConfig), 'hunter2')

      const metadata = await provider.getMetadata()

      expect(metadata.objects).toEqual([
        {
          name: 'dbo',
          kind: 'schema',
          children: [
            {
              name: 'orders',
              kind: 'table',
              children: [
                { name: 'id', kind: 'column', detail: 'int' },
                { name: 'total', kind: 'column', detail: 'decimal' }
              ]
            },
            {
              name: 'customers',
              kind: 'table',
              children: [{ name: 'id', kind: 'column', detail: 'int' }]
            }
          ]
        }
      ])
    })
  })
})
