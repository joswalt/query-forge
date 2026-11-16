import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseProvider, ResultChunk, TestResult } from '@shared/types/database-provider'
import type { DrivingQuery } from '@shared/dml/dml-statement'
import type {
  ContainerTarget,
  DocumentWrite,
  DocumentWriteOptions,
  DocumentWriteResult,
  DocumentWriter,
  DrivingQueryOptions,
  DrivingQueryPage,
  ReadDocumentResult
} from '@shared/types/document-writer'
import type { DmlCommitSummary, DmlOutcomeRow, DmlPlanSummary } from '@shared/types/dml-run'
import { QueryExecutionService } from './query-execution-service'
import type { QueryExecutionRequest, QueryExecutionResponse } from './protocol'

function cosmosProfile(readOnly = false): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Cosmos',
    readOnly,
    config: {
      kind: 'cosmos-db',
      endpoint: 'https://example.documents.azure.com',
      authMode: 'account-key',
      database: 'shop',
      container: 'orders'
    },
    hasSecret: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A Cosmos-shaped fake: a Database Provider with the DocumentWriter
 * capability. `pages` drive the Driving Query; `onWrite` decides each
 * Document Write's result (immediately, or when the test resolves it). */
class FakeCosmosProvider implements DatabaseProvider, DocumentWriter {
  partitionKeyPaths = ['/customerId']
  pages: DrivingQueryPage[] = []
  pagesServed = 0
  drivingQueries: Array<{ query: DrivingQuery; options: DrivingQueryOptions }> = []
  canceledExecutionIds: string[] = []
  writes: Array<{ write: DocumentWrite; options?: DocumentWriteOptions }> = []
  inFlight = 0
  maxInFlight = 0
  onWrite: (write: DocumentWrite) => Promise<DocumentWriteResult> = async () => ({
    outcome: 'success',
    requestCharge: 5
  })
  /** When set, decides each Driving Query's pages instead of `pages`. */
  respond?: (query: DrivingQuery) => DrivingQueryPage[]
  /** Called after each page is served, before the next is requested. */
  afterPage: (pageIndex: number) => void = () => {}

  async connect(): Promise<void> {}
  async testConnection(): Promise<TestResult> {
    return { success: true }
  }
  async disconnect(): Promise<void> {}
  async *executeQuery(): AsyncIterable<ResultChunk> {}
  cancel(executionId: string): void {
    this.canceledExecutionIds.push(executionId)
  }
  async getMetadata() {
    return { objects: [] }
  }
  async readDocument(): Promise<ReadDocumentResult> {
    return { outcome: 'not-found', requestCharge: 1 }
  }
  async readPartitionKeyPaths(_target: ContainerTarget): Promise<string[]> {
    return this.partitionKeyPaths
  }
  async *runDrivingQuery(
    query: DrivingQuery,
    options: DrivingQueryOptions
  ): AsyncIterable<DrivingQueryPage> {
    this.drivingQueries.push({ query, options })
    const pages = this.respond ? this.respond(query) : this.pages
    for (const [index, page] of pages.entries()) {
      this.pagesServed++
      yield page
      this.afterPage(index)
    }
  }
  async writeDocument(
    write: DocumentWrite,
    options?: DocumentWriteOptions
  ): Promise<DocumentWriteResult> {
    this.writes.push({ write, options })
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return await this.onWrite(write)
    } finally {
      this.inFlight--
    }
  }
}

/** Driving Query rows for documents `doc-<n>` in partition `cust-<n>`. */
function matches(from: number, to: number): unknown[] {
  const rows = []
  for (let n = from; n <= to; n++) {
    rows.push({ id: `doc-${n}`, _etag: `"e${n}"`, _rid: `r${n}`, __pkv1: `cust-${n}`, __pk1: true })
  }
  return rows
}

async function connected(
  provider: FakeCosmosProvider,
  readOnly = false
): Promise<QueryExecutionService> {
  const service = new QueryExecutionService(() => provider)
  await service.handle(
    { id: 'c', method: 'connect', profile: cosmosProfile(readOnly), secret: undefined },
    () => {}
  )
  return service
}

async function call(
  service: QueryExecutionService,
  request: QueryExecutionRequest
): Promise<QueryExecutionResponse[]> {
  const responses: QueryExecutionResponse[] = []
  await service.handle(request, (response) => responses.push(response))
  return responses
}

function planRequest(
  overrides: Partial<Extract<QueryExecutionRequest, { method: 'planDml' }>> = {}
): Extract<QueryExecutionRequest, { method: 'planDml' }> {
  return {
    id: 'plan',
    method: 'planDml',
    profileId: 'profile-1',
    tabId: 'tab-1',
    executionId: 'exec-plan',
    statement: 'DELETE FROM c WHERE c.status = "stale"',
    ...overrides
  }
}

function terminal(responses: QueryExecutionResponse[]): QueryExecutionResponse {
  return responses[responses.length - 1]
}

function errorMessage(responses: QueryExecutionResponse[]): string {
  const last = terminal(responses)
  if (last.kind !== 'error') throw new Error(`expected an error, got ${JSON.stringify(last)}`)
  return last.message
}

function planSummary(responses: QueryExecutionResponse[]): DmlPlanSummary {
  const last = terminal(responses)
  if (last.kind !== 'result') throw new Error(`expected a result, got ${JSON.stringify(last)}`)
  return last.value as DmlPlanSummary
}

async function plan(
  service: QueryExecutionService,
  overrides: Partial<Extract<QueryExecutionRequest, { method: 'planDml' }>> = {}
): Promise<string> {
  const planId = planSummary(await call(service, planRequest(overrides))).planId
  if (!planId) throw new Error('expected a held DML Plan')
  return planId
}

function commitRequest(planId: string, executionId = 'exec-commit'): QueryExecutionRequest {
  return { id: 'commit', method: 'commitDml', planId, executionId }
}

function chunksOf(responses: QueryExecutionResponse[]): ResultChunk[] {
  return responses.flatMap((r) => (r.kind === 'chunk' ? [r.value] : []))
}

function outcomeRows(responses: QueryExecutionResponse[]): DmlOutcomeRow[] {
  return chunksOf(responses).flatMap((chunk) => chunk.rows as DmlOutcomeRow[])
}

const noOutcomes = {
  written: 0,
  unchanged: 0,
  'concurrent-change': 0,
  'not-found': 0,
  'expression-undefined': 0,
  failed: 0,
  'not-attempted': 0
}

function summaryOf(responses: QueryExecutionResponse[]): DmlCommitSummary | undefined {
  return chunksOf(responses).at(-1)?.meta?.dmlSummary
}

describe('QueryExecutionService DML Statements', () => {
  describe('planDml', () => {
    it('a read-only profile refuses before the Driving Query runs', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 2), requestCharge: 3 }]
      const service = await connected(provider, true)

      const responses = await call(service, planRequest())

      expect(responses).toHaveLength(1)
      expect(errorMessage(responses)).toContain('read-only')
      expect(provider.drivingQueries).toEqual([])
    })

    it('runs the Driving Query to the end and holds a DML Plan of every match', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: matches(1, 2), requestCharge: 3 },
        { rows: matches(3, 3), requestCharge: 1.5 }
      ]
      const service = await connected(provider)

      const responses = await call(
        service,
        planRequest({ database: 'shop', container: 'customers' })
      )

      expect(responses).toEqual([
        { id: 'plan', kind: 'progress', value: { matched: 2, requestCharge: 3 }, done: false },
        { id: 'plan', kind: 'progress', value: { matched: 3, requestCharge: 4.5 }, done: false },
        {
          id: 'plan',
          kind: 'result',
          value: {
            planId: expect.any(String),
            verb: 'DELETE',
            matchCount: 3,
            drivingQueryRequestCharge: 4.5,
            partitionKeyPaths: ['/customerId'],
            sample: [
              { id: 'doc-1', partitionKey: 'cust-1' },
              { id: 'doc-2', partitionKey: 'cust-2' },
              { id: 'doc-3', partitionKey: 'cust-3' }
            ]
          },
          done: true
        }
      ])
      expect(provider.drivingQueries).toHaveLength(1)
      const [{ query, options }] = provider.drivingQueries
      expect(query.query).toContain('WHERE c.status = "stale"')
      expect(query.query).toContain('IS_DEFINED(c.customerId)')
      expect(options).toEqual({ database: 'shop', container: 'customers', executionId: 'exec-plan' })
    })

    it('refuses a DML syntax error without running a Driving Query', async () => {
      const provider = new FakeCosmosProvider()
      const service = await connected(provider)

      const responses = await call(service, planRequest({ statement: 'DELETE FROM c' }))

      expect(errorMessage(responses)).toContain('WHERE is required')
      expect(provider.drivingQueries).toEqual([])
    })

    it('ignores the Row Limit and refuses at 50,001 matches, paging no further', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = Array.from({ length: 600 }, (_, i) => ({
        rows: matches(i * 100 + 1, i * 100 + 100),
        requestCharge: 1
      }))
      const service = await connected(provider)

      const responses = await call(service, planRequest())

      expect(errorMessage(responses)).toContain('Narrow your WHERE')
      expect(errorMessage(responses)).toContain('more than 50,000 documents')
      expect(provider.pagesServed).toBe(501)
    })

    it('holds a plan of exactly 50,000 matches', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = Array.from({ length: 500 }, (_, i) => ({
        rows: matches(i * 100 + 1, i * 100 + 100),
        requestCharge: 1
      }))
      const service = await connected(provider)

      const summary = planSummary(await call(service, planRequest()))

      expect(summary.matchCount).toBe(50_000)
      expect(summary.planId).toEqual(expect.any(String))
    })

    it('zero matches holds no DML Plan and reports the Driving Query RU', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: [], requestCharge: 2.8 }]
      const service = await connected(provider)

      const summary = planSummary(await call(service, planRequest()))

      expect(summary).toEqual({
        verb: 'DELETE',
        matchCount: 0,
        drivingQueryRequestCharge: 2.8,
        partitionKeyPaths: ['/customerId'],
        sample: []
      })
    })

    it('reports the average document size from the Driving Query’s retrieved documents', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: matches(1, 2), requestCharge: 3, retrievedDocumentCount: 2, retrievedDocumentSize: 3000 },
        { rows: matches(3, 4), requestCharge: 3, retrievedDocumentCount: 3, retrievedDocumentSize: 7000 }
      ]
      const service = await connected(provider)

      const summary = planSummary(await call(service, planRequest()))

      expect(summary.averageDocumentSize).toBe(2000)
    })

    it('leaves the average document size out when no query metrics came back', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 2), requestCharge: 3 }]
      const service = await connected(provider)

      const summary = planSummary(await call(service, planRequest()))

      expect(summary).not.toHaveProperty('averageDocumentSize')
    })

    it('samples the first 10 matches of a DELETE by address only', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: matches(1, 4), requestCharge: 1 },
        { rows: matches(5, 12), requestCharge: 1 }
      ]
      const service = await connected(provider)

      const summary = planSummary(await call(service, planRequest()))

      expect(summary.matchCount).toBe(12)
      expect(summary.sample).toEqual(
        Array.from({ length: 10 }, (_, i) => ({ id: `doc-${i + 1}`, partitionKey: `cust-${i + 1}` }))
      )
    })

    it('reads a missing partition key as the None value and a hierarchical key level by level', async () => {
      const provider = new FakeCosmosProvider()
      provider.partitionKeyPaths = ['/tenant', '/region']
      provider.pages = [
        {
          rows: [
            { id: 'a', _etag: '"1"', __pkv1: 't1', __pk1: true, __pkv2: null, __pk2: true },
            { id: 'b', _etag: '"2"', __pkv1: 't1', __pk1: true, __pk2: false }
          ],
          requestCharge: 1
        }
      ]
      const service = await connected(provider)
      const planId = await plan(service)

      const responses = await call(service, commitRequest(planId))

      expect(provider.writes.map((w) => [w.write.id, w.write.partitionKey])).toEqual([
        ['a', ['t1', null]],
        ['b', ['t1', {}]]
      ])
      expect(outcomeRows(responses).map(({ id, tenant, region }) => ({ id, tenant, region }))).toEqual([
        { id: 'a', tenant: 't1', region: null },
        { id: 'b', tenant: 't1', region: undefined }
      ])
    })
  })

  describe('commitDml', () => {
    it('writes exactly the held DML Plan: one low-priority delete with ifMatch per document', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 3), requestCharge: 3 }]
      const service = await connected(provider)
      const planId = await plan(service, { container: 'customers' })
      // The container changes after planning; the commit must not re-match.
      provider.pages = [{ rows: matches(7, 9), requestCharge: 3 }]

      const responses = await call(service, commitRequest(planId))

      expect(terminal(responses)).toEqual({ id: 'commit', kind: 'result', value: undefined, done: true })
      expect(provider.drivingQueries).toHaveLength(1)
      expect(provider.writes.map((w) => w.write).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [1, 2, 3].map((n) => ({
          kind: 'delete',
          id: `doc-${n}`,
          partitionKey: `cust-${n}`,
          ifMatch: `"e${n}"`,
          container: 'customers'
        }))
      )
      expect(provider.writes.every((w) => w.options?.priorityLevel === 'Low')).toBe(true)
    })

    it('a plan is written once: committing it again finds no held DML Plan', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 1), requestCharge: 1 }]
      const service = await connected(provider)
      const planId = await plan(service)
      await call(service, commitRequest(planId))

      const again = await call(service, commitRequest(planId))

      expect(errorMessage(again)).toContain('no longer held')
      expect(provider.writes).toHaveLength(1)
    })

    it('checks read-only again, writing nothing when the profile became read-only', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 2), requestCharge: 1 }]
      const service = await connected(provider)
      const planId = await plan(service)
      await call(service, {
        id: 'c2',
        method: 'connect',
        profile: cosmosProfile(true),
        secret: undefined
      })

      const responses = await call(service, commitRequest(planId))

      expect(responses).toHaveLength(1)
      expect(errorMessage(responses)).toContain('read-only')
      expect(provider.writes).toEqual([])
    })

    it('reports a DELETE Write Outcome per document: 404 is written, a failed etag check a Concurrent Change, anything else failed with a scrubbed message', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 4), requestCharge: 2 }]
      provider.onWrite = async (write) => {
        switch (write.id) {
          case 'doc-1':
            return { outcome: 'success', requestCharge: 5.5 }
          case 'doc-2':
            return { outcome: 'not-found', requestCharge: 1.2 }
          case 'doc-3':
            return { outcome: 'precondition-failed', requestCharge: 1.3 }
          default:
            throw new Error('Request rate is large after retries; key=super-secret')
        }
      }
      const service = await connected(provider)
      const planId = await plan(service)

      const responses = await call(service, commitRequest(planId))

      const rows = outcomeRows(responses).sort((a, b) => a.id.localeCompare(b.id))
      expect(rows).toEqual([
        { id: 'doc-1', customerId: 'cust-1', outcome: 'written', requestCharge: 5.5, message: '' },
        {
          id: 'doc-2',
          customerId: 'cust-2',
          outcome: 'written',
          requestCharge: 1.2,
          message: 'This document was already deleted.'
        },
        {
          id: 'doc-3',
          customerId: 'cust-3',
          outcome: 'concurrent-change',
          requestCharge: 1.3,
          message: expect.stringContaining('changed after the DML Plan was made')
        },
        {
          id: 'doc-4',
          customerId: 'cust-4',
          outcome: 'failed',
          requestCharge: 0,
          message: 'Request rate is large after retries; key=***'
        }
      ])
      expect(summaryOf(responses)).toEqual({
        verb: 'DELETE',
        counts: {
          written: 2,
          unchanged: 0,
          'concurrent-change': 1,
          'not-found': 0,
          'expression-undefined': 0,
          failed: 1,
          'not-attempted': 0
        },
        drivingQueryRequestCharge: 2,
        writeRequestCharge: 8,
        durationMs: expect.any(Number),
        cancelled: false
      })
    })

    it('streams outcome rows in completion order, with progress on every chunk and the summary on the last', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 250), requestCharge: 1 }]
      const pending = new Map<string, Deferred<DocumentWriteResult>>()
      provider.onWrite = (write) => {
        const d = deferred<DocumentWriteResult>()
        pending.set(write.id, d)
        return d.promise
      }
      const service = await connected(provider)
      const planId = await plan(service)

      const committing = call(service, commitRequest(planId))
      // Complete in reverse dispatch order within each pool's worth.
      const completionOrder: string[] = []
      while (completionOrder.length < 250) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const ready = [...pending.keys()].reverse()
        for (const id of ready) {
          completionOrder.push(id)
          pending.get(id)!.resolve({ outcome: 'success', requestCharge: 2 })
          pending.delete(id)
        }
      }
      const responses = await committing

      expect(outcomeRows(responses).map((r) => r.id)).toEqual(completionOrder)
      const chunks = chunksOf(responses)
      expect(chunks.length).toBeGreaterThan(1)
      let completed = 0
      for (const chunk of chunks) {
        completed += chunk.rows.length
        expect(chunk.meta?.dmlProgress).toEqual({
          completed,
          total: 250,
          requestCharge: completed * 2,
          counts: { ...noOutcomes, written: completed }
        })
      }
      expect(chunks.slice(0, -1).every((chunk) => chunk.meta?.dmlSummary === undefined)).toBe(true)
      expect(summaryOf(responses)?.counts.written).toBe(250)
    })

    it('keeps at most 8 Document Writes in flight', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 40), requestCharge: 1 }]
      provider.onWrite = () =>
        new Promise((resolve) => setTimeout(() => resolve({ outcome: 'success', requestCharge: 1 }), 1))
      const service = await connected(provider)
      const planId = await plan(service)

      const responses = await call(service, commitRequest(planId))

      expect(provider.maxInFlight).toBe(8)
      expect(outcomeRows(responses)).toHaveLength(40)
    })
  })

  describe('UPDATE', () => {
    const statement = 'UPDATE c SET c.status = "archived", c.legacy = undefined WHERE c.age > 3'

    /** A Driving Query row of the UPDATE above for `doc-<n>`. */
    function updateMatch(
      n: number,
      columns: Record<string, unknown> = {
        __set1: 'archived',
        __def1: true,
        __cur1: 'active',
        __def2: true,
        __cur2: 'x'
      }
    ): Record<string, unknown> {
      return { id: `doc-${n}`, _etag: `"e${n}"`, _rid: `r${n}`, __pkv1: `cust-${n}`, __pk1: true, ...columns }
    }

    it('writes one low-priority patch with ifMatch per document, setting the value Cosmos computed and removing the undefined path', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: [updateMatch(1)], requestCharge: 3 }]
      const service = await connected(provider)
      const planId = await plan(service, { statement, container: 'customers' })

      const responses = await call(service, commitRequest(planId))

      expect(provider.drivingQueries[0].query.query).toContain('("archived") AS __set1')
      expect(provider.writes).toEqual([
        {
          write: {
            kind: 'patch',
            id: 'doc-1',
            partitionKey: 'cust-1',
            ifMatch: '"e1"',
            operations: [
              { op: 'set', path: '/status', value: 'archived' },
              { op: 'remove', path: '/legacy' }
            ],
            container: 'customers'
          },
          options: { priorityLevel: 'Low' }
        }
      ])
      expect(outcomeRows(responses)).toEqual([
        { id: 'doc-1', customerId: 'cust-1', outcome: 'written', requestCharge: 5, message: '' }
      ])
      expect(summaryOf(responses)).toMatchObject({ verb: 'UPDATE', counts: { written: 1 } })
    })
    it('samples each match with every SET path’s current and new value', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        {
          rows: [
            updateMatch(1),
            // status absent today; legacy already absent.
            updateMatch(2, { __set1: 'archived', __def1: false, __def2: false }),
            // the SET expression came back undefined.
            updateMatch(3, { __def1: true, __cur1: { nested: true }, __def2: true, __cur2: null })
          ],
          requestCharge: 1
        }
      ]
      const service = await connected(provider)

      const summary = planSummary(await call(service, planRequest({ statement })))

      expect(summary.verb).toBe('UPDATE')
      expect(summary.sample).toEqual([
        {
          id: 'doc-1',
          partitionKey: 'cust-1',
          changes: [
            { target: 'c.status', current: { defined: true, value: 'active' }, next: { defined: true, value: 'archived' } },
            { target: 'c.legacy', current: { defined: true, value: 'x' }, next: { defined: false } }
          ]
        },
        {
          id: 'doc-2',
          partitionKey: 'cust-2',
          changes: [
            { target: 'c.status', current: { defined: false }, next: { defined: true, value: 'archived' } },
            { target: 'c.legacy', current: { defined: false }, next: { defined: false } }
          ]
        },
        {
          id: 'doc-3',
          partitionKey: 'cust-3',
          changes: [
            { target: 'c.status', current: { defined: true, value: { nested: true } }, next: { defined: false } },
            { target: 'c.legacy', current: { defined: true, value: null }, next: { defined: false } }
          ]
        }
      ])
    })

    it('drops a remove whose path is already absent from a patch that still sets something', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: [updateMatch(1, { __set1: 'archived', __def1: true, __cur1: 'active', __def2: false })], requestCharge: 1 }
      ]
      const service = await connected(provider)
      const planId = await plan(service, { statement })

      const responses = await call(service, commitRequest(planId))

      expect(provider.writes.map((w) => w.write)).toMatchObject([
        { kind: 'patch', id: 'doc-1', operations: [{ op: 'set', path: '/status', value: 'archived' }] }
      ])
      expect(outcomeRows(responses).map((r) => r.outcome)).toEqual(['written'])
    })
    it('a document whose only changes are removes of already-absent paths ends unchanged with nothing sent', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: [updateMatch(1, { __def1: false }), updateMatch(2, { __def1: true, __cur1: 1 })], requestCharge: 1 }
      ]
      const service = await connected(provider)
      const planId = await plan(service, { statement: 'UPDATE c SET c.legacy = undefined WHERE true' })

      const responses = await call(service, commitRequest(planId))

      expect(provider.writes.map((w) => w.write)).toMatchObject([
        { kind: 'patch', id: 'doc-2', operations: [{ op: 'remove', path: '/legacy' }] }
      ])
      const rows = outcomeRows(responses).sort((a, b) => a.id.localeCompare(b.id))
      expect(rows.map(({ id, outcome, requestCharge }) => ({ id, outcome, requestCharge }))).toEqual([
        { id: 'doc-1', outcome: 'unchanged', requestCharge: 0 },
        { id: 'doc-2', outcome: 'written', requestCharge: 5 }
      ])
      expect(rows[0].message).toContain('already absent')
      expect(summaryOf(responses)?.counts).toMatchObject({ written: 1, unchanged: 1 })
    })
    it('a non-literal SET that came back undefined ends expression-undefined with nothing sent', async () => {
      const provider = new FakeCosmosProvider()
      // Cosmos leaves an undefined projection out of the row: no __set1.
      provider.pages = [
        { rows: [updateMatch(1, { __def1: true, __cur1: 'a', __def2: true, __cur2: 'x' })], requestCharge: 1 }
      ]
      const service = await connected(provider)
      const planId = await plan(service, {
        statement: 'UPDATE c SET c.status = c.missing, c.legacy = undefined WHERE true'
      })

      const responses = await call(service, commitRequest(planId))

      expect(provider.writes).toEqual([])
      const [row] = outcomeRows(responses)
      expect(row).toMatchObject({ id: 'doc-1', outcome: 'expression-undefined', requestCharge: 0 })
      expect(row.message).toContain('c.status')
      expect(summaryOf(responses)?.counts['expression-undefined']).toBe(1)
    })
    it('reports an UPDATE Write Outcome per document: 404 is not-found, a failed etag check a Concurrent Change, a patch 400 failed with a scrubbed message', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: [1, 2, 3].map((n) => updateMatch(n)), requestCharge: 2 }]
      provider.onWrite = async (write) => {
        switch (write.id) {
          case 'doc-1':
            return { outcome: 'not-found', requestCharge: 1.2 }
          case 'doc-2':
            return { outcome: 'precondition-failed', requestCharge: 1.3 }
          default:
            throw new Error('Bad request: path /legacy/x does not exist; key=super-secret')
        }
      }
      const service = await connected(provider)
      const planId = await plan(service, { statement })

      const responses = await call(service, commitRequest(planId))

      const rows = outcomeRows(responses).sort((a, b) => a.id.localeCompare(b.id))
      expect(rows).toEqual([
        {
          id: 'doc-1',
          customerId: 'cust-1',
          outcome: 'not-found',
          requestCharge: 1.2,
          message: expect.stringContaining('deleted after the DML Plan was made')
        },
        {
          id: 'doc-2',
          customerId: 'cust-2',
          outcome: 'concurrent-change',
          requestCharge: 1.3,
          message: expect.stringContaining('changed after the DML Plan was made')
        },
        {
          id: 'doc-3',
          customerId: 'cust-3',
          outcome: 'failed',
          requestCharge: 0,
          message: 'Bad request: path /legacy/x does not exist; key=***'
        }
      ])
      expect(summaryOf(responses)?.counts).toMatchObject({
        'not-found': 1,
        'concurrent-change': 1,
        failed: 1
      })
    })
  })

  describe('cancel', () => {
    it('during planning stops the Driving Query and keeps no DML Plan', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: matches(1, 100), requestCharge: 1 },
        { rows: matches(101, 200), requestCharge: 1 },
        { rows: matches(201, 300), requestCharge: 1 }
      ]
      const service = await connected(provider)
      provider.afterPage = (index) => {
        if (index === 0) {
          void service.handle(
            { id: 'x', method: 'cancel', profileId: 'profile-1', executionId: 'exec-plan' },
            () => {}
          )
        }
      }

      const responses = await call(service, planRequest())

      expect(terminal(responses).kind).toBe('error')
      expect(provider.canceledExecutionIds).toEqual(['exec-plan'])
      expect(provider.pagesServed).toBeLessThan(3)
      expect(responses.some((r) => r.kind === 'result')).toBe(false)
    })

    it('during commit stops dispatching: in-flight writes report real outcomes, the rest are not attempted, and the run carries cancelled', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 20), requestCharge: 1 }]
      const pending: Array<Deferred<DocumentWriteResult>> = []
      provider.onWrite = () => {
        const d = deferred<DocumentWriteResult>()
        pending.push(d)
        return d.promise
      }
      const service = await connected(provider)
      const planId = await plan(service)

      const committing = call(service, commitRequest(planId, 'exec-commit'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(pending).toHaveLength(8)
      await call(service, {
        id: 'x',
        method: 'cancel',
        profileId: 'profile-1',
        executionId: 'exec-commit'
      })
      pending.forEach((d, i) =>
        d.resolve(i === 0 ? { outcome: 'precondition-failed', requestCharge: 1 } : { outcome: 'success', requestCharge: 3 })
      )
      const responses = await committing

      expect(provider.writes).toHaveLength(8)
      const rows = outcomeRows(responses)
      expect(rows).toHaveLength(20)
      expect(rows.filter((r) => r.outcome === 'not-attempted').map((r) => r.id)).toEqual(
        matches(9, 20).map((m) => (m as { id: string }).id)
      )
      expect(summaryOf(responses)).toMatchObject({
        counts: { written: 7, 'concurrent-change': 1, 'not-attempted': 12 },
        writeRequestCharge: 22,
        cancelled: true
      })
      expect(terminal(responses)).toMatchObject({ kind: 'result', done: true })
    })
  })

  describe('held DML Plans', () => {
    async function heldPlan(): Promise<{
      provider: FakeCosmosProvider
      service: QueryExecutionService
      planId: string
    }> {
      const provider = new FakeCosmosProvider()
      provider.pages = [{ rows: matches(1, 2), requestCharge: 1 }]
      const service = await connected(provider)
      return { provider, service, planId: await plan(service) }
    }

    async function expectDropped(
      service: QueryExecutionService,
      provider: FakeCosmosProvider,
      planId: string
    ): Promise<void> {
      expect(errorMessage(await call(service, commitRequest(planId)))).toContain('no longer held')
      expect(provider.writes).toEqual([])
    }

    it('discardPlan drops the held DML Plan', async () => {
      const { provider, service, planId } = await heldPlan()

      expect(await call(service, { id: 'd', method: 'discardPlan', planId })).toEqual([
        { id: 'd', kind: 'result', value: undefined, done: true }
      ])

      await expectDropped(service, provider, planId)
    })

    it('a new plan in the same tab drops the previous one, even when it is refused', async () => {
      const { provider, service, planId } = await heldPlan()

      await call(service, planRequest({ statement: 'DELETE FROM c' }))

      await expectDropped(service, provider, planId)
    })

    it('a new plan refused on a read-only profile still drops the tab’s held DML Plan', async () => {
      const { provider, service, planId } = await heldPlan()
      await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(true), secret: undefined })

      expect(errorMessage(await call(service, planRequest()))).toContain('read-only')
      await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(), secret: undefined })

      await expectDropped(service, provider, planId)
    })

    it('a plan in another tab leaves the held DML Plan alone', async () => {
      const { provider, service, planId } = await heldPlan()

      await plan(service, { tabId: 'tab-2' })
      await call(service, commitRequest(planId))

      expect(provider.writes).toHaveLength(2)
    })

    it('releaseTab drops the tab’s held DML Plan', async () => {
      const { provider, service, planId } = await heldPlan()

      await call(service, { id: 'r', method: 'releaseTab', tabId: 'tab-1' })

      await expectDropped(service, provider, planId)
    })

    it('planning that ends after releaseTab holds no DML Plan', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: matches(1, 2), requestCharge: 1 },
        { rows: matches(3, 4), requestCharge: 1 }
      ]
      const service = await connected(provider)
      provider.afterPage = (index) => {
        if (index === 0) void service.handle({ id: 'r', method: 'releaseTab', tabId: 'tab-1' }, () => {})
      }

      const summary = planSummary(await call(service, planRequest()))

      expect(summary.matchCount).toBe(4)
      expect(summary.planId).toBeUndefined()
    })

    it('disconnect drops the profile’s held DML Plans', async () => {
      const { provider, service, planId } = await heldPlan()

      await call(service, { id: 'x', method: 'disconnect', profileId: 'profile-1' })
      await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(), secret: undefined })

      await expectDropped(service, provider, planId)
    })
  })

  describe('Retry', () => {
    type Outcome = 'success' | 'precondition-failed' | 'not-found' | 'throws'

    /** Commits a DELETE of `doc-1`…`doc-<n>` in tab-1 where each document's
     * Document Write ends as `outcomes` says (`success` otherwise). */
    async function committed(
      n: number,
      outcomes: Record<string, Outcome> = {},
      provider = new FakeCosmosProvider()
    ): Promise<{ provider: FakeCosmosProvider; service: QueryExecutionService; planId: string }> {
      provider.pages = [{ rows: matches(1, n), requestCharge: 1 }]
      provider.onWrite = async (write) => {
        const outcome = outcomes[write.id] ?? 'success'
        if (outcome === 'throws') throw new Error('Service unavailable')
        return { outcome, requestCharge: 5 }
      }
      const service = await connected(provider)
      const planId = await plan(service)
      await call(service, commitRequest(planId))
      provider.onWrite = async () => ({ outcome: 'success', requestCharge: 5 })
      provider.writes = []
      return { provider, service, planId }
    }

    /** Cosmos DB evaluating a Driving Query over `current`, the rows that
     * match the statement's WHERE today. A scoped one's `IN` lists match
     * any combination of the listed ids and partition key values. */
    function scopedTo(current: Array<Record<string, unknown>>, requestCharge = 2) {
      return (query: DrivingQuery): DrivingQueryPage[] => {
        if (query.parameters.length === 0) return [{ rows: current, requestCharge }]
        const values = (prefix: string): unknown[] =>
          query.parameters.filter((p) => p.name.startsWith(prefix)).map((p) => p.value)
        const ids = values('@id')
        const keys = values('@pk1_')
        return [
          {
            rows: current.filter((row) => ids.includes(row.id) && keys.includes(row.__pkv1)),
            requestCharge
          }
        ]
      }
    }

    function retryRequest(
      planId: string,
      overrides: Partial<Extract<QueryExecutionRequest, { method: 'planRetry' }>> = {}
    ): QueryExecutionRequest {
      return {
        id: 'retry',
        method: 'planRetry',
        planId,
        tabId: 'tab-1',
        executionId: 'exec-retry',
        ...overrides
      }
    }

    const match = (n: number, etag = `"e${n}"`, key = `cust-${n}`): Record<string, unknown> => ({
      id: `doc-${n}`,
      _etag: etag,
      _rid: `r${n}`,
      __pkv1: key,
      __pk1: true
    })

    it('re-plans only the documents not written or unchanged, scoped to their addresses, with scopeCount', async () => {
      const { provider, service, planId } = await committed(5, {
        'doc-2': 'precondition-failed',
        'doc-3': 'throws',
        'doc-4': 'not-found'
      })
      provider.respond = scopedTo([match(1), match(2), match(3), match(5)])

      const summary = planSummary(await call(service, retryRequest(planId)))

      expect(summary).toEqual({
        planId: expect.any(String),
        verb: 'DELETE',
        matchCount: 2,
        scopeCount: 2,
        drivingQueryRequestCharge: 2,
        partitionKeyPaths: ['/customerId'],
        sample: [
          { id: 'doc-2', partitionKey: 'cust-2' },
          { id: 'doc-3', partitionKey: 'cust-3' }
        ]
      })
      const { query, options } = provider.drivingQueries.at(-1)!
      expect(query.query).toContain('WHERE (c.status = "stale") AND c.id IN')
      expect(query.parameters.map((p) => p.value)).toEqual(['doc-2', 'doc-3', 'cust-2', 'cust-3'])
      expect(options).toEqual({ executionId: 'exec-retry' })
    })

    it('commits against current versions, leaving documents that no longer match or were deleted without a Write Outcome', async () => {
      const { provider, service, planId } = await committed(4, {
        'doc-2': 'precondition-failed',
        'doc-3': 'precondition-failed',
        'doc-4': 'throws'
      })
      // doc-2 changed (new _etag) and still matches; doc-3 no longer
      // matches; doc-4 was deleted.
      provider.respond = scopedTo([match(1), match(2, '"e2-v2"')])
      const retry = planSummary(await call(service, retryRequest(planId)))

      const responses = await call(service, commitRequest(retry.planId!, 'exec-retry-commit'))

      expect(retry).toMatchObject({ matchCount: 1, scopeCount: 3 })
      expect(provider.writes.map((w) => w.write)).toEqual([
        { kind: 'delete', id: 'doc-2', partitionKey: 'cust-2', ifMatch: '"e2-v2"' }
      ])
      expect(outcomeRows(responses)).toEqual([
        { id: 'doc-2', customerId: 'cust-2', outcome: 'written', requestCharge: 5, message: '' }
      ])
      expect(summaryOf(responses)).toMatchObject({ counts: { ...noOutcomes, written: 1 } })
    })

    it('re-evaluates SET against the current version of an UPDATE', async () => {
      const provider = new FakeCosmosProvider()
      provider.pages = [
        { rows: [{ ...match(1), __set1: 6, __def1: true, __cur1: 5 }], requestCharge: 1 }
      ]
      provider.onWrite = async () => ({ outcome: 'precondition-failed', requestCharge: 1 })
      const service = await connected(provider)
      const planId = await plan(service, { statement: 'UPDATE c SET c.n = c.n + 1 WHERE c.n < 10' })
      await call(service, commitRequest(planId))
      provider.onWrite = async () => ({ outcome: 'success', requestCharge: 5 })
      provider.respond = scopedTo([{ ...match(1, '"e1-v2"'), __set1: 8, __def1: true, __cur1: 7 }])

      const retry = planSummary(await call(service, retryRequest(planId)))
      await call(service, commitRequest(retry.planId!))

      expect(provider.drivingQueries.at(-1)!.query.query).toContain('(c.n + 1) AS __set1')
      expect(provider.drivingQueries.at(-1)!.query.query).toContain('WHERE (c.n < 10) AND')
      expect(provider.writes.at(-1)!.write).toEqual({
        kind: 'patch',
        id: 'doc-1',
        partitionKey: 'cust-1',
        ifMatch: '"e1-v2"',
        operations: [{ op: 'set', path: '/n', value: 8 }]
      })
    })

    it('keeps only exact id and partition key matches', async () => {
      const { provider, service, planId } = await committed(2, {
        'doc-1': 'precondition-failed',
        'doc-2': 'precondition-failed'
      })
      // doc-1 also exists in cust-2: the IN lists match it, its address doesn't.
      provider.respond = scopedTo([match(1), match(1, '"other"', 'cust-2'), match(2)])

      const retry = planSummary(await call(service, retryRequest(planId)))

      expect(retry.matchCount).toBe(2)
      expect(retry.sample).toEqual([
        { id: 'doc-1', partitionKey: 'cust-1' },
        { id: 'doc-2', partitionKey: 'cust-2' }
      ])
    })

    it('runs the scoped Driving Query in chunks of at most 1,000 addresses, one after another', async () => {
      const failing = Object.fromEntries(
        Array.from({ length: 2_500 }, (_, i) => [`doc-${i + 1}`, 'precondition-failed' as const])
      )
      const { provider, service, planId } = await committed(2_500, failing)
      provider.drivingQueries = []
      provider.respond = scopedTo(
        Array.from({ length: 2_500 }, (_, i) => match(i + 1)),
        1.5
      )

      const responses = await call(service, retryRequest(planId))

      expect(provider.drivingQueries).toHaveLength(3)
      expect(
        provider.drivingQueries.map((q) => q.query.parameters.filter((p) => p.name.startsWith('@id')).length)
      ).toEqual([1_000, 1_000, 500])
      expect(planSummary(responses)).toMatchObject({
        matchCount: 2_500,
        scopeCount: 2_500,
        drivingQueryRequestCharge: 4.5
      })
      expect(responses.filter((r) => r.kind === 'progress').map((r) => r.value)).toEqual([
        { matched: 1_000, requestCharge: 1.5 },
        { matched: 2_000, requestCharge: 3 },
        { matched: 2_500, requestCharge: 4.5 }
      ])
    })

    it('cancel stops between chunks and keeps no DML Plan', async () => {
      const failing = Object.fromEntries(
        Array.from({ length: 2_500 }, (_, i) => [`doc-${i + 1}`, 'precondition-failed' as const])
      )
      const { provider, service, planId } = await committed(2_500, failing)
      provider.drivingQueries = []
      provider.respond = scopedTo(Array.from({ length: 2_500 }, (_, i) => match(i + 1)))
      provider.afterPage = () =>
        void service.handle(
          { id: 'x', method: 'cancel', profileId: 'profile-1', executionId: 'exec-retry' },
          () => {}
        )

      const responses = await call(service, retryRequest(planId))

      expect(terminal(responses).kind).toBe('error')
      expect(provider.drivingQueries).toHaveLength(1)
      expect(provider.canceledExecutionIds).toContain('exec-retry')
    })

    it('a Retry can itself be retried, scoped to what the Retry left not written', async () => {
      const { provider, service, planId } = await committed(3, {
        'doc-1': 'precondition-failed',
        'doc-2': 'precondition-failed'
      })
      provider.respond = scopedTo([match(1, '"e1-v2"'), match(2, '"e2-v2"')])
      const retry = planSummary(await call(service, retryRequest(planId)))
      provider.onWrite = async (write) => ({
        outcome: write.id === 'doc-2' ? 'precondition-failed' : 'success',
        requestCharge: 5
      })
      await call(service, commitRequest(retry.planId!))
      provider.respond = scopedTo([match(2, '"e2-v3"')])

      const again = planSummary(await call(service, retryRequest(retry.planId!)))

      expect(again).toMatchObject({ matchCount: 1, scopeCount: 1 })
      expect(provider.drivingQueries.at(-1)!.query.parameters.map((p) => p.value)).toEqual([
        'doc-2',
        'cust-2'
      ])
      // The committed Retry replaced the original run.
      expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
        'can no longer be retried'
      )
    })

    it('a read-only profile refuses a Retry before any Driving Query runs', async () => {
      const { provider, service, planId } = await committed(2, { 'doc-1': 'precondition-failed' })
      provider.drivingQueries = []
      await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(true), secret: undefined })

      const responses = await call(service, retryRequest(planId))

      expect(errorMessage(responses)).toContain('read-only')
      expect(provider.drivingQueries).toEqual([])
    })

    it('a refused Retry still drops the tab’s held DML Plan', async () => {
      const { provider, service, planId } = await committed(2, { 'doc-1': 'precondition-failed' })
      provider.respond = scopedTo([match(1)])
      const held = planSummary(await call(service, retryRequest(planId))).planId!

      expect(errorMessage(await call(service, retryRequest('gone')))).toContain(
        'can no longer be retried'
      )

      expect(errorMessage(await call(service, commitRequest(held)))).toContain('no longer held')
      expect(provider.writes).toEqual([])
    })

    it('a Retry refused on a read-only profile still drops the tab’s held DML Plan', async () => {
      const { provider, service, planId } = await committed(2, { 'doc-1': 'precondition-failed' })
      provider.respond = scopedTo([match(1)])
      const held = planSummary(await call(service, retryRequest(planId))).planId!
      await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(true), secret: undefined })

      expect(errorMessage(await call(service, retryRequest(planId)))).toContain('read-only')
      await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(), secret: undefined })

      expect(errorMessage(await call(service, commitRequest(held)))).toContain('no longer held')
      expect(provider.writes).toEqual([])
    })

    describe('the last committed run', () => {
      async function retryable(): Promise<{
        provider: FakeCosmosProvider
        service: QueryExecutionService
        planId: string
      }> {
        const held = await committed(2, { 'doc-1': 'precondition-failed' })
        held.provider.respond = scopedTo([match(1)])
        return held
      }

      it('survives discarding a Retry at the confirmation', async () => {
        const { service, planId } = await retryable()
        const retry = planSummary(await call(service, retryRequest(planId)))
        await call(service, { id: 'd', method: 'discardPlan', planId: retry.planId! })

        expect(planSummary(await call(service, retryRequest(planId))).matchCount).toBe(1)
      })

      it('is dropped by a plan for an ordinary statement in the tab, even a refused one', async () => {
        const { service, planId } = await retryable()

        await call(service, planRequest({ statement: 'DELETE FROM c' }))

        expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
          'can no longer be retried'
        )
      })

      it('is dropped by a plan for an ordinary statement refused on a read-only profile', async () => {
        const { service, planId } = await retryable()
        await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(true), secret: undefined })
        await call(service, planRequest())
        await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(), secret: undefined })

        expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
          'can no longer be retried'
        )
      })

      it('is left alone by a plan in another tab', async () => {
        const { service, planId } = await retryable()

        await plan(service, { tabId: 'tab-2' })

        expect(planSummary(await call(service, retryRequest(planId))).matchCount).toBe(1)
      })

      it('belongs to its tab', async () => {
        const { service, planId } = await retryable()

        expect(errorMessage(await call(service, retryRequest(planId, { tabId: 'tab-2' })))).toContain(
          'can no longer be retried'
        )
      })

      it('is dropped by releaseTab', async () => {
        const { service, planId } = await retryable()

        await call(service, { id: 'r', method: 'releaseTab', tabId: 'tab-1' })

        expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
          'can no longer be retried'
        )
      })

      it('is not kept for a commit that ends after releaseTab, which runs to its end', async () => {
        const provider = new FakeCosmosProvider()
        provider.pages = [{ rows: matches(1, 3), requestCharge: 1 }]
        const pending: Array<Deferred<DocumentWriteResult>> = []
        provider.onWrite = () => {
          const d = deferred<DocumentWriteResult>()
          pending.push(d)
          return d.promise
        }
        const service = await connected(provider)
        const planId = await plan(service)

        const committing = call(service, commitRequest(planId))
        await new Promise((resolve) => setTimeout(resolve, 0))
        await call(service, { id: 'r', method: 'releaseTab', tabId: 'tab-1' })
        pending.forEach((d, i) =>
          d.resolve(
            i === 0
              ? { outcome: 'precondition-failed', requestCharge: 1 }
              : { outcome: 'success', requestCharge: 5 }
          )
        )
        const responses = await committing

        expect(summaryOf(responses)).toMatchObject({
          counts: { ...noOutcomes, written: 2, 'concurrent-change': 1 },
          cancelled: false
        })
        expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
          'can no longer be retried'
        )
      })

      it('a Retry whose planning ends after releaseTab holds no DML Plan', async () => {
        const { provider, service, planId } = await retryable()
        provider.afterPage = () =>
          void service.handle({ id: 'r', method: 'releaseTab', tabId: 'tab-1' }, () => {})

        const summary = planSummary(await call(service, retryRequest(planId)))

        expect(summary.matchCount).toBe(1)
        expect(summary.planId).toBeUndefined()
      })

      it('is dropped by disconnect', async () => {
        const { service, planId } = await retryable()

        await call(service, { id: 'x', method: 'disconnect', profileId: 'profile-1' })
        await call(service, { id: 'c', method: 'connect', profile: cosmosProfile(), secret: undefined })

        expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
          'can no longer be retried'
        )
      })

      it('is replaced when another run in the tab commits', async () => {
        const { provider, service, planId } = await retryable()
        provider.respond = undefined
        provider.pages = [{ rows: matches(5, 5), requestCharge: 1 }]
        provider.onWrite = async () => ({ outcome: 'precondition-failed', requestCharge: 1 })
        const second = await plan(service)
        await call(service, commitRequest(second))
        provider.respond = scopedTo([match(5)])

        expect(errorMessage(await call(service, retryRequest(planId)))).toContain(
          'can no longer be retried'
        )
        expect(planSummary(await call(service, retryRequest(second))).sample).toEqual([
          { id: 'doc-5', partitionKey: 'cust-5' }
        ])
      })
    })
  })
})
