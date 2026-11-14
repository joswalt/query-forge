import { describe, expect, it } from 'vitest'
import {
  initialQueryRunState,
  MAX_DISPLAY_ROWS,
  queryRunReducer,
  retainedRowCount,
  type QueryRunState
} from './query-run-reducer'

describe('queryRunReducer', () => {
  it('starts a fresh run, clearing any previous result', () => {
    const previous = queryRunReducer(initialQueryRunState, {
      type: 'chunk',
      chunk: { rows: [{ a: 1 }] }
    })

    const next = queryRunReducer(previous, { type: 'started', startedAt: 100 })

    expect(next).toEqual({
      status: 'running',
      resultSets: [],
      rowCount: 0,
      ruTotal: undefined,
      stoppedAtRowLimit: false,
      startedAt: 100,
      finishedAt: undefined,
      errorMessage: undefined
    })
  })

  it('accumulates rows and row count across chunks', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })
    const afterFirst = queryRunReducer(afterStart, {
      type: 'chunk',
      chunk: { rows: [{ a: 1 }, { a: 2 }] }
    })
    const afterSecond = queryRunReducer(afterFirst, {
      type: 'chunk',
      chunk: { rows: [{ a: 3 }] }
    })

    expect(afterSecond.resultSets).toEqual([
      { rows: [{ a: 1 }, { a: 2 }, { a: 3 }], rowCount: 3 }
    ])
    expect(afterSecond.rowCount).toBe(3)
  })

  it('sums Cosmos RU charges across chunks, leaving ruTotal undefined when never reported', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })
    const afterFirst = queryRunReducer(afterStart, {
      type: 'chunk',
      chunk: { rows: [], meta: { ru: 2.5 } }
    })
    const afterSecond = queryRunReducer(afterFirst, {
      type: 'chunk',
      chunk: { rows: [], meta: { ru: 1.1 } }
    })

    expect(afterSecond.ruTotal).toBeCloseTo(3.6)

    // Azure SQL chunks never carry `meta.ru` — ruTotal must stay undefined,
    // not silently become 0 (user story 35: "when available").
    const sqlChunkOnly = queryRunReducer(afterStart, { type: 'chunk', chunk: { rows: [{ a: 1 }] } })
    expect(sqlChunkOnly.ruTotal).toBeUndefined()
  })

  it('flags stoppedAtRowLimit when a chunk reports truncated, and clears it on the next run', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })
    expect(afterStart.stoppedAtRowLimit).toBe(false)

    const afterTruncated = queryRunReducer(afterStart, {
      type: 'chunk',
      chunk: { rows: [{ a: 1 }], meta: { ru: 1, truncated: true } }
    })
    expect(afterTruncated.stoppedAtRowLimit).toBe(true)

    const restarted = queryRunReducer(afterTruncated, { type: 'started', startedAt: 5 })
    expect(restarted.stoppedAtRowLimit).toBe(false)
  })

  it('caps displayed rows at MAX_DISPLAY_ROWS while rowCount keeps the true total', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })
    const bigChunk = { rows: Array.from({ length: MAX_DISPLAY_ROWS + 50 }, (_, i) => ({ i })) }

    const next = queryRunReducer(afterStart, { type: 'chunk', chunk: bigChunk })

    expect(next.resultSets[0].rows).toHaveLength(MAX_DISPLAY_ROWS)
    expect(next.rowCount).toBe(MAX_DISPLAY_ROWS + 50)

    // Further chunks stop growing `rows` but keep counting.
    const afterMore = queryRunReducer(next, { type: 'chunk', chunk: { rows: [{ i: 'extra' }] } })
    expect(afterMore.resultSets[0].rows).toHaveLength(MAX_DISPLAY_ROWS)
    expect(afterMore.rowCount).toBe(MAX_DISPLAY_ROWS + 51)
  })

  describe('multiple Result Sets (user story 61)', () => {
    const started = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })

    it('routes chunks to their Result Set, treating a missing index as set 0', () => {
      let state = started
      for (const chunk of [
        { rows: [{ a: 1 }] },
        { rows: [{ b: 1 }], resultSet: 1 },
        { rows: [{ a: 2 }], resultSet: 0 }
      ]) {
        state = queryRunReducer(state, { type: 'chunk', chunk })
      }

      expect(state.resultSets).toEqual([
        { rows: [{ a: 1 }, { a: 2 }], rowCount: 2 },
        { rows: [{ b: 1 }], rowCount: 1 }
      ])
      expect(state.rowCount).toBe(3)
    })

    it('keeps an empty Result Set that was announced with a zero-row chunk', () => {
      const state = queryRunReducer(started, { type: 'chunk', chunk: { rows: [], resultSet: 1 } })

      expect(state.resultSets).toEqual([
        { rows: [], rowCount: 0 },
        { rows: [], rowCount: 0 }
      ])
    })

    it('shares the MAX_DISPLAY_ROWS cap across sets while each set keeps its true rowCount', () => {
      const big = { rows: Array.from({ length: MAX_DISPLAY_ROWS - 1 }, (_, i) => ({ i })) }
      let state = queryRunReducer(started, { type: 'chunk', chunk: big })
      state = queryRunReducer(state, {
        type: 'chunk',
        chunk: { rows: [{ k: 1 }, { k: 2 }, { k: 3 }], resultSet: 1 }
      })

      expect(state.resultSets[1].rows).toEqual([{ k: 1 }])
      expect(state.resultSets[1].rowCount).toBe(3)
      expect(retainedRowCount(state)).toBe(MAX_DISPLAY_ROWS)
    })
  })

  it('transitions to success on done, preserving accumulated rows', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })
    const afterChunk = queryRunReducer(afterStart, { type: 'chunk', chunk: { rows: [{ a: 1 }] } })

    const done = queryRunReducer(afterChunk, { type: 'done', finishedAt: 42 })

    expect(done.status).toBe('success')
    expect(done.finishedAt).toBe(42)
    expect(done.resultSets[0].rows).toEqual([{ a: 1 }])
  })

  it('reports a genuine failure with its error message (user story 30, 37)', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })

    const failed = queryRunReducer(afterStart, {
      type: 'failed',
      message: 'Invalid column name',
      finishedAt: 10,
      cancelled: false
    })

    expect(failed.status).toBe('error')
    expect(failed.errorMessage).toBe('Invalid column name')
  })

  it('reports a user-requested cancellation distinctly from a real error (user stories 26, 30)', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })

    // Cosmos/mssql's cancel surfaces as the underlying provider's own error
    // (an AbortError / TDS Attention) — the UI must not show it as a failure
    // when the user themself asked for cancellation.
    const cancelled = queryRunReducer(afterStart, {
      type: 'failed',
      message: 'AbortError: The operation was aborted',
      finishedAt: 10,
      cancelled: true
    })

    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.errorMessage).toBeUndefined()
  })
})

describe('queryRunReducer with Addressable Rows', () => {
  const target = { connectionId: 'profile-1', database: 'orders-db', container: 'orders' }
  const system = { _rid: 'r1', _self: 's1', _etag: '"e1"', _ts: 1 }

  function cosmosRun(rows: unknown[], partitionKeyPaths?: string[]): QueryRunState {
    const started = queryRunReducer(initialQueryRunState, {
      type: 'started',
      startedAt: 1,
      documentTarget: target
    })
    return queryRunReducer(started, {
      type: 'chunk',
      chunk: { rows, meta: partitionKeyPaths ? { partitionKeyPaths, ru: 2.5 } : { ru: 2.5 } }
    })
  }

  it('keeps the container the rows came from and its partition key paths from the first chunk', () => {
    const first = cosmosRun([{ id: 'a1', customerId: 'c1' }], ['/customerId'])
    const second = queryRunReducer(first, { type: 'chunk', chunk: { rows: [{ id: 'a2' }] } })
    expect(second).toMatchObject({ documentTarget: target, partitionKeyPaths: ['/customerId'] })

    const rerun = queryRunReducer(second, { type: 'started', startedAt: 2 })
    expect(rerun.partitionKeyPaths).toBeUndefined()
    expect(rerun.documentTarget).toBeUndefined()
  })

  it('updates a saved full-document row in place and marks it edited, without a re-run', () => {
    const run = cosmosRun(
      [
        { id: 'a1', customerId: 'c1', name: 'Ada', ...system },
        { id: 'a2', customerId: 'c1', name: 'Grace', ...system }
      ],
      ['/customerId']
    )
    const saved = { id: 'a2', customerId: 'c1', name: 'Grace Hopper', ...system, _etag: '"e2"' }
    const next = queryRunReducer(run, {
      type: 'documentSaved',
      target,
      address: { id: 'a2', partitionKey: 'c1' },
      document: saved,
      previous: run.resultSets[0].rows[1] as Record<string, unknown>
    })
    expect(next.resultSets[0].rows).toEqual([run.resultSets[0].rows[0], saved])
    expect(next.resultSets[0].rowMarks).toEqual({ 1: 'edited' })
    expect(next.status).toBe(run.status)
    expect(next.ruTotal).toBe(2.5)
  })

  it('refreshes only the projected columns of a saved projection row', () => {
    const run = cosmosRun(
      [{ id: 'a1', customerId: 'c1', name: 'Ada', nickname: 'A', total: 3 }],
      ['/customerId']
    )
    const previous = { id: 'a1', customerId: 'c1', name: 'Ada', nickname: 'A', city: 'London', ...system }
    const saved = { id: 'a1', customerId: 'c1', name: 'Ada Lovelace', city: 'Paris', ...system }
    const next = queryRunReducer(run, {
      type: 'documentSaved',
      target,
      address: { id: 'a1', partitionKey: 'c1' },
      document: saved,
      previous
    })
    // `nickname` was removed by the save; `total` is not a document property
    // (an alias or computed value), so it is left as it was.
    expect(next.resultSets[0].rows).toEqual([{ id: 'a1', customerId: 'c1', name: 'Ada Lovelace', total: 3 }])
  })

  it('strikes through the row of a document found deleted by someone else', () => {
    const run = cosmosRun(
      [
        { id: 'a1', customerId: 'c1' },
        { id: 'a2', customerId: 'c1' }
      ],
      ['/customerId']
    )
    const next = queryRunReducer(run, {
      type: 'documentGone',
      target,
      address: { id: 'a1', partitionKey: 'c1' }
    })
    expect(next.resultSets[0].rows).toEqual(run.resultSets[0].rows)
    expect(next.resultSets[0].rowMarks).toEqual({ 0: 'gone' })
  })

  it('removes the rows of a deleted document from the grid, keeping later row marks on their rows', () => {
    const run = queryRunReducer(
      cosmosRun(
        [
          { id: 'a1', customerId: 'c1' },
          { id: 'a2', customerId: 'c1' },
          { id: 'a3', customerId: 'c1' }
        ],
        ['/customerId']
      ),
      { type: 'documentGone', target, address: { id: 'a3', partitionKey: 'c1' } }
    )
    const next = queryRunReducer(run, {
      type: 'documentDeleted',
      target,
      address: { id: 'a1', partitionKey: 'c1' }
    })
    expect(next.resultSets[0].rows).toEqual([
      { id: 'a2', customerId: 'c1' },
      { id: 'a3', customerId: 'c1' }
    ])
    expect(next.resultSets[0].rowMarks).toEqual({ 1: 'gone' })
    expect(next.resultSets[0].rowCount).toBe(2)
    expect(next.rowCount).toBe(2)
    expect(next.ruTotal).toBe(2.5)
  })

  it('ignores a delete from another container or of an address no row has', () => {
    const run = cosmosRun([{ id: 'a1', customerId: 'c1' }], ['/customerId'])
    const elsewhere = queryRunReducer(run, {
      type: 'documentDeleted',
      target: { ...target, container: 'archive' },
      address: { id: 'a1', partitionKey: 'c1' }
    })
    const unknown = queryRunReducer(run, {
      type: 'documentDeleted',
      target,
      address: { id: 'zz', partitionKey: 'c1' }
    })
    expect(elsewhere).toBe(run)
    expect(unknown).toBe(run)
  })

  it('leaves rows from another container alone, even with the same address', () => {
    const run = cosmosRun([{ id: 'a1', customerId: 'c1' }], ['/customerId'])
    const next = queryRunReducer(run, {
      type: 'documentGone',
      target: { ...target, container: 'archive' },
      address: { id: 'a1', partitionKey: 'c1' }
    })
    expect(next).toEqual(run)
  })

  it('changes nothing when no row has the saved address', () => {
    const run = cosmosRun([{ id: 'a1', customerId: 'c1' }], ['/customerId'])
    const next = queryRunReducer(run, {
      type: 'documentSaved',
      target,
      address: { id: 'zz', partitionKey: 'c1' },
      document: { id: 'zz', customerId: 'c1' },
      previous: { id: 'zz', customerId: 'c1' }
    })
    expect(next).toEqual(run)
  })
})
