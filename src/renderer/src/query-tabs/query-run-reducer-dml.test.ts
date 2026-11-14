import { describe, expect, it } from 'vitest'
import type { DmlCommitSummary } from '@shared/types/dml-run'
import { emptyOutcomeCounts } from '@shared/types/dml-run'
import {
  initialQueryRunState,
  queryRunReducer,
  type QueryRunAction,
  type QueryRunState
} from './query-run-reducer'

function fold(actions: QueryRunAction[], from: QueryRunState = initialQueryRunState): QueryRunState {
  return actions.reduce(queryRunReducer, from)
}

const planningStarted: QueryRunAction = {
  type: 'dmlPlanningStarted',
  startedAt: 100,
  verb: 'DELETE',
  container: 'customers'
}

const planned: QueryRunAction = {
  type: 'dmlPlanned',
  summary: { planId: 'plan-1', verb: 'DELETE', matchCount: 3, drivingQueryRequestCharge: 4.5 },
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
      matched: 200,
      requestCharge: 12.5
    })
  })

  it('a held DML Plan moves to confirming, still busy, with the plan numbers', () => {
    const state = fold([planningStarted, planned])

    expect(state.status).toBe('running')
    expect(state.dml).toEqual({
      phase: 'confirming',
      verb: 'DELETE',
      container: 'customers',
      planId: 'plan-1',
      matchCount: 3,
      drivingQueryRequestCharge: 4.5
    })
  })

  it('zero matches ends the run with the Driving Query RU and nothing to confirm', () => {
    const state = fold([
      planningStarted,
      {
        type: 'dmlPlanned',
        summary: { verb: 'DELETE', matchCount: 0, drivingQueryRequestCharge: 2.8 },
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
          meta: { ru: 10, dmlProgress: { completed: 2, total: 3, requestCharge: 10 } }
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
      matchCount: 3,
      drivingQueryRequestCharge: 4.5,
      progress: { completed: 2, total: 3, requestCharge: 10 },
      stopRequested: false,
      summary: undefined
    })
  })

  it('starts committing at zero of the match count', () => {
    const state = fold([planningStarted, planned, { type: 'dmlCommitStarted' }])

    expect(state.dml).toMatchObject({
      phase: 'committing',
      progress: { completed: 0, total: 3, requestCharge: 0 }
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
            dmlProgress: { completed: 3, total: 3, requestCharge: 15 },
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
          meta: { dmlProgress: { completed: 3, total: 3, requestCharge: 5 }, dmlSummary: stoppedSummary }
        }
      },
      { type: 'done', finishedAt: 900 }
    ])

    expect(state.status).toBe('cancelled')
    expect(state.dml).toEqual({
      phase: 'stopped',
      verb: 'DELETE',
      container: 'customers',
      matchCount: 3,
      summary: stoppedSummary
    })
  })

  it('a commit that fails keeps the outcome rows it already streamed', () => {
    const state = fold([
      planningStarted,
      planned,
      { type: 'dmlCommitStarted' },
      { type: 'chunk', chunk: { rows: [row('a')], meta: { dmlProgress: { completed: 1, total: 3, requestCharge: 5 } } } },
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

  it('an ordinary query run clears the DML phase', () => {
    const state = fold([planningStarted, planned, { type: 'dmlDiscarded', finishedAt: 1 }, { type: 'started', startedAt: 2 }])

    expect(state.dml).toBeUndefined()
  })
})
