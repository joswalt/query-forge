import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../local-storage/test-support/create-test-db'
import { QueryHistoryRepository } from '../local-storage/query-history-repository'
import { recordQueryHistory, searchQueryHistory, SessionQueryText } from './session-query-text'

describe('Session Query Text', () => {
  let repository: QueryHistoryRepository
  let sessionText: SessionQueryText

  beforeEach(() => {
    repository = new QueryHistoryRepository(createTestDb())
    sessionText = new SessionQueryText()
  })

  function record(queryText: string, persist: boolean, executedAt?: string): string {
    return recordQueryHistory(
      repository,
      sessionText,
      {
        profileId: 'p1',
        profileName: 'Ecom (prod)',
        queryText,
        status: 'success',
        durationMs: 1,
        executedAt
      },
      persist
    ).id
  }

  it('never writes the text to disk when the opt-in is off', () => {
    record('SELECT * FROM orders', false)

    expect(repository.list()[0].queryText).toBeUndefined()
  })

  it('shows the held text for this session, marked session-only', () => {
    record('SELECT * FROM orders', false)

    const [entry] = sessionText.fill(repository.list())
    expect(entry.queryText).toBe('SELECT * FROM orders')
    expect(entry.queryTextSessionOnly).toBe(true)
  })

  it('persists the text and holds nothing when the opt-in is on', () => {
    record('SELECT * FROM orders', true)

    const [entry] = sessionText.fill(repository.list())
    expect(repository.list()[0].queryText).toBe('SELECT * FROM orders')
    expect(entry.queryTextSessionOnly).toBeUndefined()
  })

  it('finds an entry by its session-only text, case-insensitively', () => {
    record('SELECT * FROM Orders', false)
    record('SELECT * FROM stores', false)

    const results = searchQueryHistory(repository, sessionText, 'orders')
    expect(results.map((e) => e.queryText)).toEqual(['SELECT * FROM Orders'])
  })

  it('merges session and repository matches most recent first, without duplicates', () => {
    record('SELECT 1 -- orders older', false, '2026-01-01T00:00:00.000Z')
    record('SELECT 2 -- orders newer', true, '2026-01-02T00:00:00.000Z')

    const results = searchQueryHistory(repository, sessionText, 'orders')
    expect(results.map((e) => e.queryText)).toEqual([
      'SELECT 2 -- orders newer',
      'SELECT 1 -- orders older'
    ])
  })

  it('drops an entry whose row was cleared from disk', () => {
    record('SELECT * FROM orders', false)
    repository.clear()

    expect(searchQueryHistory(repository, sessionText, 'orders')).toEqual([])
  })

  it('forgets everything on clear', () => {
    const id = record('SELECT * FROM orders', false)
    sessionText.clear()

    expect(sessionText.fill([repository.get(id)!])[0].queryText).toBeUndefined()
  })
})
