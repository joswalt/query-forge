import { describe, expect, it, beforeEach } from 'vitest'
import { createTestDb } from './test-support/create-test-db'
import { QueryHistoryRepository } from './query-history-repository'

describe('QueryHistoryRepository', () => {
  let repository: QueryHistoryRepository

  beforeEach(() => {
    repository = new QueryHistoryRepository(createTestDb())
  })

  it('records a successful run and retrieves it via list', () => {
    const entry = repository.record({
      profileId: 'profile-1',
      profileName: 'Orders (prod)',
      queryText: 'SELECT * FROM orders',
      status: 'success',
      durationMs: 42,
      rowCount: 10
    })

    const [listed] = repository.list()

    expect(listed).toEqual(entry)
    expect(listed.status).toBe('success')
    expect(listed.queryText).toBe('SELECT * FROM orders')
    expect(listed.rowCount).toBe(10)
    expect(listed.errorMessage).toBeUndefined()
  })

  it('omits query text entirely when not given one (opt-in withheld)', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders (prod)',
      queryText: undefined,
      status: 'success',
      durationMs: 5
    })

    const [listed] = repository.list()

    expect(listed.queryText).toBeUndefined()
  })

  it('records an error outcome with its error message', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders (prod)',
      queryText: undefined,
      status: 'error',
      durationMs: 5,
      errorMessage: 'Invalid column name'
    })

    const [listed] = repository.list()

    expect(listed.status).toBe('error')
    expect(listed.errorMessage).toBe('Invalid column name')
  })

  it('records a cancelled outcome distinctly from an error', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders (prod)',
      queryText: undefined,
      status: 'cancelled',
      durationMs: 5
    })

    const [listed] = repository.list()

    expect(listed.status).toBe('cancelled')
    expect(listed.errorMessage).toBeUndefined()
  })

  it('lists most-recently-executed entries first', () => {
    const first = repository.record({
      profileId: 'profile-1',
      profileName: 'Orders',
      queryText: undefined,
      status: 'success',
      durationMs: 1
    })
    const second = repository.record({
      profileId: 'profile-1',
      profileName: 'Orders',
      queryText: undefined,
      status: 'success',
      durationMs: 1
    })

    const ids = repository.list().map((entry) => entry.id)

    expect(ids[0]).toBe(second.id)
    expect(ids[1]).toBe(first.id)
  })

  it('respects the list limit', () => {
    for (let i = 0; i < 5; i++) {
      repository.record({
        profileId: 'profile-1',
        profileName: 'Orders',
        queryText: undefined,
        status: 'success',
        durationMs: 1
      })
    }

    expect(repository.list(2)).toHaveLength(2)
  })

  it('searches by profile name', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders (prod)',
      queryText: undefined,
      status: 'success',
      durationMs: 1
    })
    repository.record({
      profileId: 'profile-2',
      profileName: 'Inventory (staging)',
      queryText: undefined,
      status: 'success',
      durationMs: 1
    })

    const results = repository.search('prod')

    expect(results).toHaveLength(1)
    expect(results[0].profileName).toBe('Orders (prod)')
  })

  it('searches by query text when present', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders',
      queryText: 'SELECT * FROM customers',
      status: 'success',
      durationMs: 1
    })
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders',
      queryText: 'SELECT * FROM orders',
      status: 'success',
      durationMs: 1
    })

    const results = repository.search('customers')

    expect(results).toHaveLength(1)
    expect(results[0].queryText).toBe('SELECT * FROM customers')
  })

  it('clears all history entries', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: 'Orders',
      queryText: 'SELECT * FROM orders',
      status: 'success',
      durationMs: 1
    })

    repository.clear()

    expect(repository.list()).toEqual([])
  })

  it('treats a literal percent sign in the search term as literal, not a wildcard', () => {
    repository.record({
      profileId: 'profile-1',
      profileName: '100% Orders',
      queryText: undefined,
      status: 'success',
      durationMs: 1
    })
    repository.record({
      profileId: 'profile-2',
      profileName: 'Something else',
      queryText: undefined,
      status: 'success',
      durationMs: 1
    })

    const results = repository.search('100%')

    expect(results).toHaveLength(1)
    expect(results[0].profileName).toBe('100% Orders')
  })
})
