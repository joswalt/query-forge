import { describe, expect, it, beforeEach } from 'vitest'
import { createTestDb } from './test-support/create-test-db'
import { SavedQueryRepository } from './saved-query-repository'

describe('SavedQueryRepository', () => {
  let repository: SavedQueryRepository

  beforeEach(() => {
    repository = new SavedQueryRepository(createTestDb())
  })

  it('creates a saved query and retrieves it via list', () => {
    const saved = repository.create({
      name: 'Top customers',
      queryText: 'SELECT * FROM customers',
      profileId: 'profile-1',
      databaseKind: 'azure-sql'
    })

    const [listed] = repository.list()

    expect(listed).toEqual(saved)
    expect(listed.name).toBe('Top customers')
    expect(listed.queryText).toBe('SELECT * FROM customers')
    expect(listed.profileId).toBe('profile-1')
    expect(listed.databaseKind).toBe('azure-sql')
  })

  it('creates a saved query with no connection/database association', () => {
    repository.create({
      name: 'Generic snippet',
      queryText: 'SELECT 1',
      profileId: undefined,
      databaseKind: undefined
    })

    const [listed] = repository.list()

    expect(listed.profileId).toBeUndefined()
    expect(listed.databaseKind).toBeUndefined()
  })

  it('gets a saved query by id', () => {
    const saved = repository.create({
      name: 'Query',
      queryText: 'SELECT 1',
      profileId: undefined,
      databaseKind: undefined
    })

    expect(repository.get(saved.id)).toEqual(saved)
  })

  it('returns undefined for a missing id', () => {
    expect(repository.get('missing')).toBeUndefined()
  })

  it('updates name and query text', () => {
    const saved = repository.create({
      name: 'Old name',
      queryText: 'SELECT 1',
      profileId: undefined,
      databaseKind: undefined
    })

    const updated = repository.update(saved.id, {
      name: 'New name',
      queryText: 'SELECT 2'
    })

    expect(updated.name).toBe('New name')
    expect(updated.queryText).toBe('SELECT 2')
  })

  it('deletes a saved query', () => {
    const saved = repository.create({
      name: 'Query',
      queryText: 'SELECT 1',
      profileId: undefined,
      databaseKind: undefined
    })

    repository.delete(saved.id)

    expect(repository.list()).toEqual([])
  })

  it('lists most-recently-updated first', () => {
    const first = repository.create({
      name: 'First',
      queryText: 'SELECT 1',
      profileId: undefined,
      databaseKind: undefined
    })
    const second = repository.create({
      name: 'Second',
      queryText: 'SELECT 2',
      profileId: undefined,
      databaseKind: undefined
    })

    const ids = repository.list().map((entry) => entry.id)

    expect(ids[0]).toBe(second.id)
    expect(ids[1]).toBe(first.id)
  })
})
