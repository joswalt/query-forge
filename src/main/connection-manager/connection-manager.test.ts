import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createTestDb } from '../local-storage/test-support/create-test-db'
import { ConnectionProfileRepository } from '../local-storage/connection-profile-repository'
import { ConnectionManager } from './connection-manager'
import type { SecretStore } from './secret-store'
import type { EntraIdAuthenticator } from './entra-id-authenticator'
import type { MsalTokenCacheRepository } from '../local-storage/msal-token-cache-repository'
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
    secretStore = new ReversingSecretStore()
    manager = new ConnectionManager(new ConnectionProfileRepository(createTestDb()), secretStore)
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

  describe('resolveSecret', () => {
    it('decrypts the stored ciphertext for a non-entra-id profile (unchanged from revealSecret)', async () => {
      const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'hunter2' })

      await expect(manager.resolveSecret(profile)).resolves.toBe('hunter2')
    })

    it('acquires an Entra ID access token via the authenticator for an entra-id profile', async () => {
      const authenticator: EntraIdAuthenticator = {
        acquireToken: vi.fn(async () => 'fresh-access-token')
      }
      const managerWithAuth = new ConnectionManager(
        new ConnectionProfileRepository(createTestDb()),
        secretStore,
        authenticator
      )
      const profile = managerWithAuth.create({
        name: 'Orders (Entra ID)',
        config: {
          ...sampleConfig,
          authMode: 'entra-id',
          entraId: { clientId: 'c', tenantId: 't', redirectUri: 'http://localhost:1234' }
        }
      })

      const token = await managerWithAuth.resolveSecret(profile)

      expect(token).toBe('fresh-access-token')
      expect(authenticator.acquireToken).toHaveBeenCalledWith(
        { clientId: 'c', tenantId: 't', redirectUri: 'http://localhost:1234' },
        expect.any(Array),
        profile.id
      )
    })

    it('throws (rather than silently succeeding) when an entra-id profile has no authenticator configured', async () => {
      const profile = manager.create({
        name: 'Orders (Entra ID)',
        config: {
          ...sampleConfig,
          authMode: 'entra-id',
          entraId: { clientId: 'c', tenantId: 't', redirectUri: 'http://localhost:1234' }
        }
      })

      await expect(manager.resolveSecret(profile)).rejects.toThrow()
    })

    it('deletes the MSAL token cache row when its connection profile is deleted', async () => {
      const tokenCacheRepository = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
      const managerWithCache = new ConnectionManager(
        new ConnectionProfileRepository(createTestDb()),
        secretStore,
        undefined,
        tokenCacheRepository as unknown as MsalTokenCacheRepository
      )
      const profile = managerWithCache.create({ name: 'Orders', config: sampleConfig })

      managerWithCache.delete(profile.id)

      expect(tokenCacheRepository.delete).toHaveBeenCalledWith(profile.id)
    })

    it('throws when an entra-id profile is missing its clientId/tenantId/redirectUri', async () => {
      const authenticator: EntraIdAuthenticator = { acquireToken: vi.fn() }
      const managerWithAuth = new ConnectionManager(
        new ConnectionProfileRepository(createTestDb()),
        secretStore,
        authenticator
      )
      const profile = managerWithAuth.create({
        name: 'Orders (Entra ID, unconfigured)',
        config: { ...sampleConfig, authMode: 'entra-id' }
      })

      await expect(managerWithAuth.resolveSecret(profile)).rejects.toThrow()
      expect(authenticator.acquireToken).not.toHaveBeenCalled()
    })
  })
})
