import { describe, expect, it } from 'vitest'
import {
  initialQueryRunState,
  MAX_DISPLAY_ROWS,
  queryRunReducer,
  retainedRowCount
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
