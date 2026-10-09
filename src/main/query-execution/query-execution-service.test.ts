import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type {
  DatabaseProvider,
  ResultChunk,
  SecretRefresher,
  TestResult
} from '@shared/types/database-provider'
import { QueryExecutionService } from './query-execution-service'
import type { QueryExecutionResponse } from './protocol'

function makeProfile(id = 'profile-1'): ConnectionProfile {
  return {
    id,
    name: 'Test',
    readOnly: false,
    config: { kind: 'azure-sql', server: 'x', database: 'y', authMode: 'sql-credentials' },
    hasSecret: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

/** A fake DatabaseProvider recording calls, standing in for Cosmos/SQL
 * Providers so the router can be tested independent of either SDK. */
class FakeProvider implements DatabaseProvider {
  connected = false
  disconnected = false
  testResult: TestResult = { success: true }
  chunks: ResultChunk[] = [{ rows: [{ id: 1 }] }, { rows: [{ id: 2 }] }]
  canceledExecutionIds: string[] = []
  metadata = { objects: [{ name: 'table1', kind: 'table' }] }

  refresher: SecretRefresher | undefined

  async connect(
    _profile?: ConnectionProfile,
    _secret?: string,
    refreshSecret?: SecretRefresher
  ): Promise<void> {
    this.connected = true
    this.refresher = refreshSecret
  }
  async testConnection(): Promise<TestResult> {
    return this.testResult
  }
  async disconnect(): Promise<void> {
    this.disconnected = true
  }
  async *executeQuery(): AsyncIterable<ResultChunk> {
    for (const chunk of this.chunks) yield chunk
  }
  cancel(executionId: string): void {
    this.canceledExecutionIds.push(executionId)
  }
  async getMetadata() {
    return this.metadata
  }
}

function collectResponses(): {
  send: (response: QueryExecutionResponse) => void
  responses: QueryExecutionResponse[]
} {
  const responses: QueryExecutionResponse[] = []
  return { send: (response) => responses.push(response), responses }
}

describe('QueryExecutionService', () => {
  it('connect: hands the provider a refresher that round-trips a renewed secret through main', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    const { send, responses } = collectResponses()

    await service.handle(
      { id: 'req-1', method: 'connect', profile: makeProfile(), secret: 'old-token' },
      send
    )
    const renewed = provider.refresher!()

    const ask = responses.find((r) => r.kind === 'refreshSecret')
    expect(ask).toMatchObject({ kind: 'refreshSecret', profileId: 'profile-1' })
    await service.handle({ id: ask!.id, method: 'refreshSecretResult', secret: 'new-token' }, send)
    await expect(renewed).resolves.toBe('new-token')
  })

  it('refreshSecretResult: rejects the waiting refresh when main reports an error', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    const { send, responses } = collectResponses()
    await service.handle(
      { id: 'req-1', method: 'connect', profile: makeProfile(), secret: 'old-token' },
      send
    )
    const renewed = provider.refresher!()
    const ask = responses.find((r) => r.kind === 'refreshSecret')!

    await service.handle({ id: ask.id, method: 'refreshSecretResult', error: 'revoked' }, send)

    await expect(renewed).rejects.toThrow('revoked')
  })

  it('connect: tracks the provider by profile id and replies once', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    const { send, responses } = collectResponses()

    await service.handle(
      { id: 'req-1', method: 'connect', profile: makeProfile(), secret: 'hunter2' },
      send
    )

    expect(provider.connected).toBe(true)
    expect(responses).toEqual([{ id: 'req-1', kind: 'result', value: undefined, done: true }])
  })

  it('testConnection: never tracks the provider, so a later getMetadata call fails', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    const { send, responses } = collectResponses()

    await service.handle(
      { id: 'req-1', method: 'testConnection', profile: makeProfile(), secret: 'hunter2' },
      send
    )
    expect(responses).toEqual([
      { id: 'req-1', kind: 'result', value: { success: true }, done: true }
    ])

    const { send: send2, responses: responses2 } = collectResponses()
    await service.handle({ id: 'req-2', method: 'getMetadata', profileId: 'profile-1' }, send2)
    expect(responses2[0]).toMatchObject({ kind: 'error' })
    expect((responses2[0] as { message: string }).message).toContain('No active connection')
  })

  it('getMetadata: routes to the tracked provider for that profile id', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    await service.handle(
      { id: 'c', method: 'connect', profile: makeProfile(), secret: undefined },
      () => {}
    )

    const { send, responses } = collectResponses()
    await service.handle({ id: 'req-1', method: 'getMetadata', profileId: 'profile-1' }, send)

    expect(responses).toEqual([
      { id: 'req-1', kind: 'result', value: provider.metadata, done: true }
    ])
  })

  it('disconnect: calls provider.disconnect() and stops tracking it', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    await service.handle(
      { id: 'c', method: 'connect', profile: makeProfile(), secret: undefined },
      () => {}
    )

    const { send, responses } = collectResponses()
    await service.handle({ id: 'req-1', method: 'disconnect', profileId: 'profile-1' }, send)

    expect(provider.disconnected).toBe(true)
    expect(responses).toEqual([{ id: 'req-1', kind: 'result', value: undefined, done: true }])

    const { send: send2, responses: responses2 } = collectResponses()
    await service.handle({ id: 'req-2', method: 'getMetadata', profileId: 'profile-1' }, send2)
    expect(responses2[0]).toMatchObject({ kind: 'error' })
  })

  it('executeQuery: streams each Result Chunk then a terminal result, tagging options.executionId', async () => {
    const provider = new FakeProvider()
    const executeQuerySpy = vi.spyOn(provider, 'executeQuery')
    const service = new QueryExecutionService(() => provider)
    await service.handle(
      { id: 'c', method: 'connect', profile: makeProfile(), secret: undefined },
      () => {}
    )

    const { send, responses } = collectResponses()
    await service.handle(
      {
        id: 'req-1',
        method: 'executeQuery',
        profileId: 'profile-1',
        executionId: 'exec-1',
        query: 'SELECT * FROM t'
      },
      send
    )

    expect(responses).toEqual([
      { id: 'req-1', kind: 'chunk', value: { rows: [{ id: 1 }] }, done: false },
      { id: 'req-1', kind: 'chunk', value: { rows: [{ id: 2 }] }, done: false },
      { id: 'req-1', kind: 'result', value: undefined, done: true }
    ])
    expect(executeQuerySpy).toHaveBeenCalledWith('SELECT * FROM t', { executionId: 'exec-1' })
  })

  it('cancel: forwards the Execution ID to the tracked provider', async () => {
    const provider = new FakeProvider()
    const service = new QueryExecutionService(() => provider)
    await service.handle(
      { id: 'c', method: 'connect', profile: makeProfile(), secret: undefined },
      () => {}
    )

    const { send, responses } = collectResponses()
    await service.handle(
      { id: 'req-1', method: 'cancel', profileId: 'profile-1', executionId: 'exec-1' },
      send
    )

    expect(provider.canceledExecutionIds).toEqual(['exec-1'])
    expect(responses).toEqual([{ id: 'req-1', kind: 'result', value: undefined, done: true }])
  })

  it('executeQuery: refuses a mutating query on a read-only profile without reaching the provider', async () => {
    const provider = new FakeProvider()
    const executeQuerySpy = vi.spyOn(provider, 'executeQuery')
    const service = new QueryExecutionService(() => provider)
    await service.handle(
      {
        id: 'c',
        method: 'connect',
        profile: { ...makeProfile(), readOnly: true },
        secret: undefined
      },
      () => {}
    )

    const { send, responses } = collectResponses()
    await service.handle(
      {
        id: 'req-1',
        method: 'executeQuery',
        profileId: 'profile-1',
        executionId: 'exec-1',
        query: 'DELETE FROM t'
      },
      send
    )

    expect(executeQuerySpy).not.toHaveBeenCalled()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ kind: 'error', done: true })
    expect((responses[0] as { message: string }).message).toContain('read-only')
  })

  it('reports a thrown provider error as an error response rather than rejecting', async () => {
    const provider = new FakeProvider()
    provider.connect = async () => {
      throw new Error('boom')
    }
    const service = new QueryExecutionService(() => provider)

    const { send, responses } = collectResponses()
    await service.handle(
      { id: 'req-1', method: 'connect', profile: makeProfile(), secret: undefined },
      send
    )

    expect(responses).toEqual([{ id: 'req-1', kind: 'error', message: 'boom', done: true }])
  })

  it('rewrites a network-interrupted query into an actionable error response', async () => {
    const provider = new FakeProvider()
    provider.executeQuery = async function* () {
      yield { rows: [{ id: 1 }] }
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    }
    const service = new QueryExecutionService(() => provider)
    const { send, responses } = collectResponses()
    await service.handle(
      { id: 'c', method: 'connect', profile: makeProfile(), secret: undefined },
      send
    )
    responses.length = 0

    await service.handle(
      {
        id: 'req-2',
        method: 'executeQuery',
        profileId: 'profile-1',
        executionId: 'exec-1',
        query: 'SELECT 1'
      },
      send
    )

    expect(responses[0]).toMatchObject({ kind: 'chunk' })
    expect(responses[1]).toMatchObject({ kind: 'error', done: true })
    expect((responses[1] as { message: string }).message).toContain('interrupted')
  })
})
