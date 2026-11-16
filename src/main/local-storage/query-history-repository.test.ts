import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './test-support/create-test-db'
import { runMigrations } from './migration-runner'
import { migrations } from './migrations'
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

  describe('DML Statement runs', () => {
    it('keeps existing entries when the migration rebuilds the table', () => {
      const db = new Database(':memory:')
      runMigrations(
        db,
        migrations.filter((m) => m.version <= 6)
      )
      db.prepare(
        `INSERT INTO query_history
           (id, profile_id, profile_name, query_text, status, duration_ms, row_count, error_message, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'old-1',
        'profile-1',
        'Orders',
        'SELECT 1',
        'success',
        12,
        3,
        null,
        '2026-01-01T00:00:00.000Z'
      )
      db.prepare(
        `INSERT INTO query_history
           (id, profile_id, profile_name, query_text, status, duration_ms, row_count, error_message, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'old-2',
        'profile-1',
        'Orders',
        null,
        'error',
        5,
        null,
        'boom',
        '2026-01-01T00:00:00.000Z'
      )

      runMigrations(db, migrations)

      expect(new QueryHistoryRepository(db).list()).toEqual([
        {
          id: 'old-2',
          profileId: 'profile-1',
          profileName: 'Orders',
          queryText: undefined,
          status: 'error',
          durationMs: 5,
          rowCount: undefined,
          errorMessage: 'boom',
          executedAt: '2026-01-01T00:00:00.000Z',
          dml: undefined
        },
        {
          id: 'old-1',
          profileId: 'profile-1',
          profileName: 'Orders',
          queryText: 'SELECT 1',
          status: 'success',
          durationMs: 12,
          rowCount: 3,
          errorMessage: undefined,
          executedAt: '2026-01-01T00:00:00.000Z',
          dml: undefined
        }
      ])
    })

    const dmlEntry = {
      profileId: 'profile-1',
      profileName: 'Shop (prod)',
      queryText: undefined,
      status: 'partial' as const,
      durationMs: 2_400,
      rowCount: 1_840,
      executedAt: '2026-11-16T10:00:00.000Z',
      dml: {
        verb: 'DELETE' as const,
        databaseName: 'shop',
        containerName: 'orders',
        counts: {
          written: 1_837,
          unchanged: 0,
          'concurrent-change': 3,
          'not-found': 0,
          'expression-undefined': 0,
          failed: 0,
          'not-attempted': 0
        },
        totalRequestCharge: 412.5,
        retry: false
      }
    }

    it('round-trips a partial DML entry with its verb, target, Write Outcome counts and RU', () => {
      const recorded = repository.record(dmlEntry)

      const [listed] = repository.list()

      expect(listed).toEqual(recorded)
      expect(listed).toEqual({
        ...dmlEntry,
        id: recorded.id,
        errorMessage: undefined
      })
    })

    it('keeps the run start given as executedAt rather than the recording time', () => {
      repository.record(dmlEntry)

      expect(repository.list()[0].executedAt).toBe('2026-11-16T10:00:00.000Z')
    })

    it('round-trips the Retry marker', () => {
      repository.record({ ...dmlEntry, dml: { ...dmlEntry.dml, retry: true } })

      expect(repository.list()[0].dml?.retry).toBe(true)
    })

    it('finds a DML entry by container name without its statement text', () => {
      repository.record(dmlEntry)
      repository.record({
        ...dmlEntry,
        dml: { ...dmlEntry.dml, containerName: 'customers' }
      })

      const results = repository.search('orders')

      expect(results).toHaveLength(1)
      expect(results[0].dml?.containerName).toBe('orders')
    })

    it('finds a DML entry by verb, case-insensitively', () => {
      repository.record(dmlEntry)
      repository.record({
        ...dmlEntry,
        dml: { ...dmlEntry.dml, verb: 'UPDATE' }
      })

      const results = repository.search('update')

      expect(results).toHaveLength(1)
      expect(results[0].dml?.verb).toBe('UPDATE')
    })

    it('gives query entries no DML detail', () => {
      repository.record({
        profileId: 'profile-1',
        profileName: 'Orders',
        queryText: 'SELECT 1',
        status: 'success',
        durationMs: 1
      })

      expect(repository.list()[0]).not.toHaveProperty('dml.verb')
      expect(repository.list()[0].dml).toBeUndefined()
    })
  })
})
