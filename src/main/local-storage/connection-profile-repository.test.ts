import { describe, expect, it, beforeEach } from 'vitest'
import { createTestDb } from './test-support/create-test-db'
import { ConnectionProfileRepository } from './connection-profile-repository'
import type { AzureSqlConnectionConfig } from '@shared/types/connection-profile'

const sampleConfig: AzureSqlConnectionConfig = {
  kind: 'azure-sql',
  server: 'example.database.windows.net',
  database: 'orders',
  authMode: 'sql-credentials',
  username: 'app-user'
}

describe('ConnectionProfileRepository', () => {
  let repository: ConnectionProfileRepository

  beforeEach(() => {
    repository = new ConnectionProfileRepository(createTestDb())
  })

  it('creates a connection profile and retrieves it by id', () => {
    const created = repository.create({
      name: 'Orders (prod)',
      readOnly: false,
      config: sampleConfig
    })

    const fetched = repository.get(created.id)

    expect(fetched).toEqual(created)
    expect(fetched?.name).toBe('Orders (prod)')
    expect(fetched?.config).toEqual(sampleConfig)
    expect(fetched?.hasSecret).toBe(false)
  })

  it('reports hasSecret true when a secret ciphertext is stored', () => {
    const created = repository.create({
      name: 'Orders (prod)',
      readOnly: false,
      config: sampleConfig,
      secretCiphertext: Buffer.from('ciphertext-bytes')
    })

    expect(created.hasSecret).toBe(true)
    expect(repository.getSecretCiphertext(created.id)).toEqual(Buffer.from('ciphertext-bytes'))
  })

  it('lists connection profiles ordered by name', () => {
    repository.create({ name: 'Zebra', readOnly: false, config: sampleConfig })
    repository.create({ name: 'Alpha', readOnly: false, config: sampleConfig })

    const names = repository.list().map((profile) => profile.name)

    expect(names).toEqual(['Alpha', 'Zebra'])
  })

  it('updates a connection profile', () => {
    const created = repository.create({ name: 'Orders', readOnly: false, config: sampleConfig })

    const updated = repository.update(created.id, { name: 'Orders (renamed)', readOnly: true })

    expect(updated.name).toBe('Orders (renamed)')
    expect(updated.readOnly).toBe(true)
    expect(updated.config).toEqual(sampleConfig)
  })

  it('clears a stored secret when secretCiphertext is explicitly set to null', () => {
    const created = repository.create({
      name: 'Orders',
      readOnly: false,
      config: sampleConfig,
      secretCiphertext: Buffer.from('ciphertext-bytes')
    })

    const updated = repository.update(created.id, { secretCiphertext: null })

    expect(updated.hasSecret).toBe(false)
    expect(repository.getSecretCiphertext(created.id)).toBeUndefined()
  })

  it('throws when updating a connection profile that does not exist', () => {
    expect(() => repository.update('missing-id', { name: 'x' })).toThrow(
      'Connection profile "missing-id" does not exist'
    )
  })

  it('deletes a connection profile', () => {
    const created = repository.create({ name: 'Orders', readOnly: false, config: sampleConfig })

    repository.delete(created.id)

    expect(repository.get(created.id)).toBeUndefined()
  })
})
