import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../local-storage/migration-runner'
import { migrations } from '../local-storage/migrations'
import { ConnectionProfileRepository } from '../local-storage/connection-profile-repository'
import { ConnectionManager } from './connection-manager'
import type { SecretStore } from './secret-store'
import type { AzureSqlConnectionConfig } from '@shared/types/connection-profile'

/** In-memory SecretStore test double — reverses the plaintext so tests can
 * assert ConnectionManager never stores or returns plaintext directly, while
 * staying fully deterministic (no real OS-level encryption needed here). */
class ReversingSecretStore implements SecretStore {
  isAvailable(): boolean {
    return true
  }
  encrypt(plaintext: string): Buffer {
    return Buffer.from([...plaintext].reverse().join(''), 'utf-8')
  }
  decrypt(ciphertext: Buffer): string {
    return [...ciphertext.toString('utf-8')].reverse().join('')
  }
}

const sampleConfig: AzureSqlConnectionConfig = {
  kind: 'azure-sql',
  server: 'example.database.windows.net',
  database: 'orders',
  authMode: 'sql-credentials',
  username: 'app-user'
}

describe('ConnectionManager', () => {
  let manager: ConnectionManager
  let secretStore: ReversingSecretStore

  beforeEach(() => {
    const db = new Database(':memory:')
    runMigrations(db, migrations)
    secretStore = new ReversingSecretStore()
    manager = new ConnectionManager(new ConnectionProfileRepository(db), secretStore)
  })

  it('creates a connection profile without a secret', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig })

    expect(profile.hasSecret).toBe(false)
    expect(manager.revealSecret(profile.id)).toBeUndefined()
  })

  it('encrypts the secret at creation time and never exposes it on the profile', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'hunter2' })

    expect(profile.hasSecret).toBe(true)
    expect(JSON.stringify(profile)).not.toContain('hunter2')
  })

  it('decrypts the stored secret via revealSecret for connect-time handoff', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'hunter2' })

    expect(manager.revealSecret(profile.id)).toBe('hunter2')
  })

  it('replaces the stored secret on update', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'hunter2' })

    manager.update(profile.id, { secret: 'new-secret' })

    expect(manager.revealSecret(profile.id)).toBe('new-secret')
  })

  it('clears the stored secret when update is called with secret: null', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'hunter2' })

    const updated = manager.update(profile.id, { secret: null })

    expect(updated.hasSecret).toBe(false)
    expect(manager.revealSecret(profile.id)).toBeUndefined()
  })

  it('leaves the stored secret untouched when update omits secret entirely', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'hunter2' })

    const updated = manager.update(profile.id, { name: 'Orders (renamed)' })

    expect(updated.name).toBe('Orders (renamed)')
    expect(manager.revealSecret(profile.id)).toBe('hunter2')
  })

  it('lists and deletes connection profiles', () => {
    const profile = manager.create({ name: 'Orders', config: sampleConfig })

    expect(manager.list().map((p) => p.id)).toContain(profile.id)

    manager.delete(profile.id)

    expect(manager.list().map((p) => p.id)).not.toContain(profile.id)
    expect(manager.get(profile.id)).toBeUndefined()
  })
})
