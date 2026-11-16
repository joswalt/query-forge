import { describe, expect, it } from 'vitest'
import type { DmlCommitSummary } from '@shared/types/dml-run'
import { emptyOutcomeCounts } from '@shared/types/dml-run'
import {
  initialQueryRunState,
  queryRunReducer,
  type QueryRunAction,
  type QueryRunState
} from './query-run-reducer'
import { retryScope } from './dml-run-state'

function fold(actions: QueryRunAction[], from: QueryRunState = initialQueryRunState): QueryRunState {
  return actions.reduce(queryRunReducer, from)
}

const planningStarted: QueryRunAction = {
  type: 'dmlPlanningStarted',
  startedAt: 100,
  verb: 'DELETE',
  container: 'customers',
  statement: 'DELETE FROM c WHERE c.stale'
}

const planned: QueryRunAction = {
  type: 'dmlPlanned',
  summary: {
    planId: 'plan-1',
    verb: 'DELETE',
    matchCount: 3,
    drivingQueryRequestCharge: 4.5,
    averageDocumentSize: 1536,
    partitionKeyPaths: ['/customerId'],
    sample: [{ id: 'a', partitionKey: 'c' }]
  },
  at: 120
}

function summary(overrides: Partial<DmlCommitSummary> = {}): DmlCommitSummary {
  return {
    verb: 'DELETE',
    counts: { ...emptyOutcomeCounts(), written: 3 },
    drivingQueryRequestCharge: 4.5,
    writeRequestCharge: 15,
    durationMs: 800,
    cancelled: false,
    ...overrides
  }
}

const written = (n: number): DmlCommitSummary['counts'] => ({ ...emptyOutcomeCounts(), written: n })

const row = (id: string): Record<string, unknown> => ({
  id,
  customerId: 'c',
  outcome: 'written',
  requestCharge: 5,
  message: ''
})

describe('queryRunReducer DML phases', () => {
  it('planning keeps the tab busy and tracks matches found so far, clearing the previous run', () => {
    const previous = fold([
      { type: 'started', startedAt: 0 },
      { type: 'chunk', chunk: { rows: [{ a: 1 }] } },
      { type: 'done', finishedAt: 5 }
    ])

    const state = fold(
      [planningStarted, { type: 'dmlPlanningProgress', progress: { matched: 200, requestCharge: 12.5 } }],
      previous
    )

    expect(state.status).toBe('running')
    expect(state.resultSets).toEqual([])
    expect(state.startedAt).toBe(100)
    expect(state.dml).toEqual({
      phase: 'planning',
      verb: 'DELETE',
      container: 'customers',
      statement: 'DELETE FROM c WHERE c.stale',
      matched: 200,
      requestCharge: 12.5
    })
  })

  it('a held DML Plan moves to confirming, still busy, with the plan numbers and the statement it was planned from', () => {
    const state = fold([planningStarted, planned])

    expect(state.status).toBe('running')
    expect(state.dml).toEqual({
      phase: 'confirming',
      verb: 'DELETE',
      container: 'customers',
      statement: 'DELETE FROM c WHERE c.stale',
      planId: 'plan-1',
      matchCount: 3,
      drivingQueryRequestCharge: 4.5,
      averageDocumentSize: 1536,
      partitionKeyPaths: ['/customerId'],
      sample: [{ id: 'a', partitionKey: 'c' }]
    })
  })

  it('an UPDATE plan confirms with its sample of current → new values', () => {
    const sample = [
      {
        id: 'a',
        partitionKey: 'c',
        changes: [
          {
            target: 'c.status',
            current: { defined: true as const, value: 'active' },
            next: { defined: true as const, value: 'archived' }
          }
        ]
      }
    ]
    const state = fold([
      { ...planningStarted, verb: 'UPDATE', statement: 'UPDATE c SET c.status = "archived" WHERE c.status = "active"' } as QueryRunAction,
      {
        type: 'dmlPlanned',
        summary: {
          planId: 'plan-2',
          verb: 'UPDATE',
          matchCount: 40,
          drivingQueryRequestCharge: 6,
          partitionKeyPaths: ['/customerId'],
          sample
        },
        at: 120
      }
    ])

    expect(state.dml).toEqual({
      phase: 'confirming',
      verb: 'UPDATE',
      container: 'customers',
      statement: 'UPDATE c SET c.status = "archived" WHERE c.status = "active"',
      planId: 'plan-2',
      matchCount: 40,
      drivingQueryRequestCharge: 6,
      partitionKeyPaths: ['/customerId'],
      sample
    })
  })

  it('zero matches ends the run with the Driving Query RU and nothing to confirm', () => {
    const state = fold([
      planningStarted,
      {
        type: 'dmlPlanned',
        summary: {
          verb: 'DELETE',
          matchCount: 0,
          drivingQueryRequestCharge: 2.8,
          partitionKeyPaths: ['/customerId'],
          sample: []
        },
        at: 130
      }
    ])

    expect(state.status).toBe('success')
    expect(state.finishedAt).toBe(130)
    expect(state.dml).toEqual({
      phase: 'zero-matches',
      verb: 'DELETE',
      container: 'customers',
      drivingQueryRequestCharge: 2.8
    })
  })

  it('discarding at the confirmation frees the tab with nothing written', () => {
    const state = fold([planningStarted, planned, { type: 'dmlDiscarded', finishedAt: 140 }])

    expect(state.status).toBe('cancelled')
    expect(state.finishedAt).toBe(140)
    expect(state.dml).toEqual({ phase: 'discarded', verb: 'DELETE', container: 'customers' })
  })

  it('cancelling during planning keeps no DML Plan: nothing was written', () => {
    const state = fold([
      planningStarted,
      { type: 'failed', message: 'aborted', finishedAt: 110, cancelled: true }
    ])

    expect(state.status).toBe('cancelled')
    expect(state.dml).toEqual({ phase: 'discarded', verb: 'DELETE', container: 'customers' })
  })

  it('a refusal during planning is an error with its message', () => {
    const state = fold([
      planningStarted,
      {
        type: 'failed',
        message: 'This connection is read-only',
        finishedAt: 110,
        cancelled: false
      }
    ])

    expect(state.status).toBe('error')
    expect(state.errorMessage).toBe('This connection is read-only')
    expect(state.dml).toEqual({
      phase: 'error',
      verb: 'DELETE',
      container: 'customers',
      stage: 'planning'
    })
  })

  it('committing streams outcome rows into the grid and progress from each chunk', () => {
    const state = fold([
      planningStarted,
      planned,
      { type: 'dmlCommitStarted' },
      {
        type: 'chunk',
        chunk: {
          rows: [row('a'), row('b')],
          meta: { ru: 10, dmlProgress: { completed: 2, total: 3, requestCharge: 10, counts: written(2) } }
        }
      }
    ])

    expect(state.status).toBe('running')
    expect(state.resultSets).toEqual([{ rows: [row('a'), row('b')], rowCount: 2 }])
    expect(state.ruTotal).toBe(10)
    expect(state.dml).toEqual({
      phase: 'committing',
      verb: 'DELETE',
      container: 'customers',
      statement: 'DELETE FROM c WHERE c.stale',
      planId: 'plan-1',
      matchCount: 3,
      drivingQueryRequestCharge: 4.5,
      progress: { completed: 2, total: 3, requestCharge: 10, counts: written(2) },
      stopRequested: false,
      summary: undefined
    })
  })

  it('starts committing at zero of the match count, with no Write Outcomes yet', () => {
    const state = fold([planningStarted, planned, { type: 'dmlCommitStarted' }])

    expect(state.dml).toMatchObject({
      phase: 'committing',
      progress: { completed: 0, total: 3, requestCharge: 0, counts: emptyOutcomeCounts() }
    })
  })

  it('Stop keeps the tab busy until in-flight writes report', () => {
    const state = fold([planningStarted, planned, { type: 'dmlCommitStarted' }, { type: 'dmlStopRequested' }])

    expect(state.status).toBe('running')
    expect(state.dml).toMatchObject({ phase: 'committing', stopRequested: true })
  })

  it('a commit that ran to the end is done, carrying the summary of the last chunk', () => {
    const state = fold([
      planningStarted,
      planned,
      { type: 'dmlCommitStarted' },
      {
        type: 'chunk',
        chunk: {
          rows: [row('a'), row('b'), row('c')],
          meta: {
            ru: 15,
            dmlProgress: { completed: 3, total: 3, requestCharge: 15, counts: written(3) },
            dmlSummary: summary()
          }
        }
      },
      { type: 'done', finishedAt: 900 }
    ])

    expect(state.status).toBe('success')
    expect(state.finishedAt).toBe(900)
    expect(state.dml).toEqual({
      phase: 'done',
      verb: 'DELETE',
      container: 'customers',
      statement: 'DELETE FROM c WHERE c.stale',
      planId: 'plan-1',
      matchCount: 3,
      summary: summary()
    })
  })

  it('a commit that was stopped ends stopped', () => {
    const stoppedSummary = summary({
      counts: { ...emptyOutcomeCounts(), written: 1, 'not-attempted': 2 },
      cancelled: true
    })
    const state = fold([
      planningStarted,
      planned,
      { type: 'dmlCommitStarted' },
      { type: 'dmlStopRequested' },
      {
        type: 'chunk',
        chunk: {
          rows: [row('a')],
          meta: { dmlProgress: { completed: 3, total: 3, requestCharge: 5, counts: stoppedSummary.counts }, dmlSummary: stoppedSummary }
        }
      },
      { type: 'done', finishedAt: 900 }
    ])

    expect(state.status).toBe('cancelled')
    expect(state.dml).toEqual({
      phase: 'stopped',
      verb: 'DELETE',
      container: 'customers',
      statement: 'DELETE FROM c WHERE c.stale',
      planId: 'plan-1',
      matchCount: 3,
      summary: stoppedSummary
    })
  })

  it('a commit that fails keeps the outcome rows it already streamed', () => {
    const state = fold([
      planningStarted,
      planned,
      { type: 'dmlCommitStarted' },
      { type: 'chunk', chunk: { rows: [row('a')], meta: { dmlProgress: { completed: 1, total: 3, requestCharge: 5, counts: written(1) } } } },
      { type: 'failed', message: 'The query execution service stopped', finishedAt: 300, cancelled: false }
    ])

    expect(state.status).toBe('error')
    expect(state.resultSets[0].rows).toEqual([row('a')])
    expect(state.dml).toEqual({
      phase: 'error',
      verb: 'DELETE',
      container: 'customers',
      stage: 'committing'
    })
  })

  describe('Retry', () => {
    const notWrittenSummary = summary({
      counts: { ...emptyOutcomeCounts(), written: 1, 'concurrent-change': 1, failed: 1 }
    })
    const finished = (runSummary = notWrittenSummary): QueryRunState =>
      fold([
        planningStarted,
        planned,
        { type: 'dmlCommitStarted' },
        {
          type: 'chunk',
          chunk: {
            rows: [row('a'), row('b'), row('c')],
            meta: {
              ru: 15,
              dmlProgress: { completed: 3, total: 3, requestCharge: 15, counts: runSummary.counts },
              dmlSummary: runSummary
            }
          }
        },
        { type: 'done', finishedAt: 900 }
      ])
    const retryStarted: QueryRunAction = { type: 'dmlRetryPlanningStarted', startedAt: 1_000 }
    const retryPlanned: QueryRunAction = {
      type: 'dmlPlanned',
      summary: {
        planId: 'retry-1',
        verb: 'DELETE',
        matchCount: 1,
        scopeCount: 2,
        drivingQueryRequestCharge: 2.5,
        partitionKeyPaths: ['/customerId'],
        sample: [{ id: 'b', partitionKey: 'c' }]
      },
      at: 1_100
    }

    it('a finished run offers a Retry of every document not written or unchanged', () => {
      expect(retryScope(finished().dml)).toBe(2)
    })

    it('a run that wrote or left unchanged every document offers no Retry', () => {
      const state = finished(summary({ counts: { ...emptyOutcomeCounts(), written: 2, unchanged: 1 } }))
      expect(retryScope(state.dml)).toBeUndefined()
    })

    it('a stopped run offers a Retry of the documents not attempted', () => {
      const state = finished(
        summary({ counts: { ...emptyOutcomeCounts(), written: 1, 'not-attempted': 2 }, cancelled: true })
      )
      expect(state.dml?.phase).toBe('stopped')
      expect(retryScope(state.dml)).toBe(2)
    })

    it('never offers a Retry mid-run', () => {
      const state = fold([
        planningStarted,
        planned,
        { type: 'dmlCommitStarted' },
        {
          type: 'chunk',
          chunk: {
            rows: [row('a')],
            meta: { dmlProgress: { completed: 1, total: 3, requestCharge: 5, counts: { ...emptyOutcomeCounts(), failed: 1 } } }
          }
        }
      ])
      expect(retryScope(state.dml)).toBeUndefined()
    })

    it('no longer offers a Retry once the last committed run is dropped', () => {
      const state = fold([{ type: 'dmlLastRunDropped' }], finished())
      expect(retryScope(state.dml)).toBeUndefined()
      expect(state.dml?.phase).toBe('done')
    })

    it('planning a Retry re-checks the documents not written, keeping the original outcome rows meanwhile', () => {
      const original = finished()

      const state = fold(
        [retryStarted, { type: 'dmlPlanningProgress', progress: { matched: 1, requestCharge: 2.5 } }],
        original
      )

      expect(state.status).toBe('running')
      expect(state.resultSets).toEqual(original.resultSets)
      expect(state.dml).toEqual({
        phase: 'planning',
        verb: 'DELETE',
        container: 'customers',
        statement: 'DELETE FROM c WHERE c.stale',
        matched: 1,
        requestCharge: 2.5,
        retry: { scopeCount: 2 }
      })
    })

    it('a planned Retry confirms with its match count and scope', () => {
      const state = fold([retryStarted, retryPlanned], finished())

      expect(state.status).toBe('running')
      expect(state.dml).toMatchObject({
        phase: 'confirming',
        planId: 'retry-1',
        matchCount: 1,
        retry: { scopeCount: 2 }
      })
    })

    it('discarding a Retry at the confirmation returns to the original run report, Retry still offered', () => {
      const original = finished()

      const state = fold([retryStarted, retryPlanned, { type: 'dmlDiscarded', finishedAt: 1_200 }], original)

      expect(state).toEqual(original)
      expect(retryScope(state.dml)).toBe(2)
    })

    it('cancelling a Retry while planning returns to the original run report', () => {
      const original = finished()

      const state = fold(
        [retryStarted, { type: 'failed', message: 'aborted', finishedAt: 1_050, cancelled: true }],
        original
      )

      expect(state).toEqual(original)
    })

    it('a Retry whose planning failed returns to the original run report with the error', () => {
      const original = finished()

      const state = fold(
        [retryStarted, { type: 'failed', message: 'Request rate is large', finishedAt: 1_050, cancelled: false }],
        original
      )

      expect(state.resultSets).toEqual(original.resultSets)
      expect(state.status).toBe(original.status)
      expect(state.dml).toEqual({ ...original.dml, retryError: 'Request rate is large' })
      expect(retryScope(state.dml)).toBe(2)
    })

    it('a Retry where nothing still matches ends with nothing to write and no confirmation', () => {
      const state = fold(
        [
          retryStarted,
          {
            type: 'dmlPlanned',
            summary: {
              verb: 'DELETE',
              matchCount: 0,
              scopeCount: 2,
              drivingQueryRequestCharge: 2.5,
              partitionKeyPaths: ['/customerId'],
              sample: []
            },
            at: 1_100
          }
        ],
        finished()
      )

      expect(state.status).toBe('success')
      expect(state.dml).toEqual({
        phase: 'zero-matches',
        verb: 'DELETE',
        container: 'customers',
        drivingQueryRequestCharge: 2.5,
        retry: { scopeCount: 2 }
      })
    })

    it('a committed Retry replaces the original outcome rows and report, and can itself be retried', () => {
      const retrySummary = summary({ counts: { ...emptyOutcomeCounts(), 'concurrent-change': 1 } })

      const committing = fold([retryStarted, retryPlanned, { type: 'dmlCommitStarted' }], finished())
      const state = fold(
        [
          {
            type: 'chunk',
            chunk: {
              rows: [{ ...row('b'), outcome: 'concurrent-change' }],
              meta: {
                ru: 1,
                dmlProgress: { completed: 1, total: 1, requestCharge: 1, counts: retrySummary.counts },
                dmlSummary: retrySummary
              }
            }
          },
          { type: 'done', finishedAt: 1_500 }
        ],
        committing
      )

      expect(committing.resultSets).toEqual([])
      expect(committing.ruTotal).toBeUndefined()
      expect(committing.dml).toMatchObject({ phase: 'committing', retry: true, matchCount: 1 })
      expect(state.resultSets).toEqual([{ rows: [{ ...row('b'), outcome: 'concurrent-change' }], rowCount: 1 }])
      expect(state.dml).toEqual({
        phase: 'done',
        verb: 'DELETE',
        container: 'customers',
        statement: 'DELETE FROM c WHERE c.stale',
        planId: 'retry-1',
        matchCount: 1,
        summary: retrySummary,
        retry: true
      })
      expect(retryScope(state.dml)).toBe(1)
    })

    it('a Retry is offered only from a finished run', () => {
      const state = fold([planningStarted, planned, retryStarted])
      expect(state.dml?.phase).toBe('confirming')
    })
  })

  it('an ordinary query run clears the DML phase', () => {
    const state = fold([planningStarted, planned, { type: 'dmlDiscarded', finishedAt: 1 }, { type: 'started', startedAt: 2 }])

    expect(state.dml).toBeUndefined()
  })
})
