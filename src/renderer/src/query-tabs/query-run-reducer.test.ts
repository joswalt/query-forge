import { describe, expect, it } from 'vitest'
import { initialQueryRunState, MAX_DISPLAY_ROWS, queryRunReducer } from './query-run-reducer'

describe('queryRunReducer', () => {
  it('starts a fresh run, clearing any previous result', () => {
    const previous = queryRunReducer(initialQueryRunState, {
      type: 'chunk',
      chunk: { rows: [{ a: 1 }] }
    })

    const next = queryRunReducer(previous, { type: 'started', startedAt: 100 })

    expect(next).toEqual({
      status: 'running',
      rows: [],
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

    expect(afterSecond.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
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

    expect(next.rows).toHaveLength(MAX_DISPLAY_ROWS)
    expect(next.rowCount).toBe(MAX_DISPLAY_ROWS + 50)

    // Further chunks stop growing `rows` but keep counting.
    const afterMore = queryRunReducer(next, { type: 'chunk', chunk: { rows: [{ i: 'extra' }] } })
    expect(afterMore.rows).toHaveLength(MAX_DISPLAY_ROWS)
    expect(afterMore.rowCount).toBe(MAX_DISPLAY_ROWS + 51)
  })

  it('transitions to success on done, preserving accumulated rows', () => {
    const afterStart = queryRunReducer(initialQueryRunState, { type: 'started', startedAt: 0 })
    const afterChunk = queryRunReducer(afterStart, { type: 'chunk', chunk: { rows: [{ a: 1 }] } })

    const done = queryRunReducer(afterChunk, { type: 'done', finishedAt: 42 })

    expect(done.status).toBe('success')
    expect(done.finishedAt).toBe(42)
    expect(done.rows).toEqual([{ a: 1 }])
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
