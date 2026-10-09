import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createTestDb } from '../local-storage/test-support/create-test-db'
import { ConnectionProfileRepository } from '../local-storage/connection-profile-repository'
import { ConnectionManager } from './connection-manager'
import type { SecretStore } from './secret-store'
import type { EntraIdAuthenticator, ServicePrincipalAuthenticator } from './entra-id-authenticator'
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

  describe('update with a changed authentication mode', () => {
    it('drops the stored secret so the old mode’s password is never reused as the new mode’s credential', () => {
      const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'sql-password' })
      expect(profile.hasSecret).toBe(true)

      const updated = manager.update(profile.id, {
        config: {
          ...sampleConfig,
          authMode: 'service-principal',
          servicePrincipal: { clientId: 'c', tenantId: 't' }
        }
      })

      expect(updated.hasSecret).toBe(false)
      expect(manager.revealSecret(profile.id)).toBeUndefined()
    })

    it('keeps the stored secret when the mode is unchanged and no new secret is sent', () => {
      const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'sql-password' })

      manager.update(profile.id, { config: { ...sampleConfig, database: 'other' } })

      expect(manager.revealSecret(profile.id)).toBe('sql-password')
    })

    it('stores a new secret sent alongside a mode change', () => {
      const profile = manager.create({ name: 'Orders', config: sampleConfig, secret: 'sql-password' })

      manager.update(profile.id, {
        config: {
          ...sampleConfig,
          authMode: 'service-principal',
          servicePrincipal: { clientId: 'c', tenantId: 't' }
        },
        secret: 'client-secret'
      })

      expect(manager.revealSecret(profile.id)).toBe('client-secret')
    })
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

    describe('service-principal profiles', () => {
      const spConfig = {
        ...sampleConfig,
        authMode: 'service-principal' as const,
        servicePrincipal: { clientId: 'sp-client', tenantId: 'sp-tenant' }
      }

      function managerWith(authenticator?: ServicePrincipalAuthenticator): ConnectionManager {
        return new ConnectionManager(
          new ConnectionProfileRepository(createTestDb()),
          secretStore,
          undefined,
          undefined,
          authenticator
        )
      }

      it('exchanges the stored client secret for an access token in main', async () => {
        const authenticator: ServicePrincipalAuthenticator = {
          acquireToken: vi.fn(async () => 'sp-access-token')
        }
        const m = managerWith(authenticator)
        const profile = m.create({ name: 'SP', config: spConfig, secret: 'the-client-secret' })

        await expect(m.resolveSecret(profile)).resolves.toBe('sp-access-token')
        expect(authenticator.acquireToken).toHaveBeenCalledWith(
          { clientId: 'sp-client', tenantId: 'sp-tenant' },
          'the-client-secret',
          ['https://database.windows.net/.default']
        )
      })

      it('uses a typed-in secret for a never-saved Test Connection instead of stored ciphertext', async () => {
        const authenticator: ServicePrincipalAuthenticator = {
          acquireToken: vi.fn(async () => 'sp-access-token')
        }
        const m = managerWith(authenticator)
        const unsaved = { ...m.create({ name: 'SP', config: spConfig }), id: 'unsaved' }

        await m.resolveSecret(unsaved, 'typed-secret')

        expect(authenticator.acquireToken).toHaveBeenCalledWith(
          expect.anything(),
          'typed-secret',
          expect.any(Array)
        )
      })

      it('throws when no client secret is stored, without calling the authenticator', async () => {
        const authenticator: ServicePrincipalAuthenticator = { acquireToken: vi.fn() }
        const m = managerWith(authenticator)
        const profile = m.create({ name: 'SP', config: spConfig })

        await expect(m.resolveSecret(profile)).rejects.toThrow(/client secret/i)
        expect(authenticator.acquireToken).not.toHaveBeenCalled()
      })

      it('throws when the client/tenant IDs are missing or no authenticator is configured', async () => {
        const authenticator: ServicePrincipalAuthenticator = { acquireToken: vi.fn() }
        const noIds = managerWith(authenticator)
        const missing = noIds.create({
          name: 'SP',
          config: { ...spConfig, servicePrincipal: undefined },
          secret: 's'
        })
        await expect(noIds.resolveSecret(missing)).rejects.toThrow(/client ID|tenant ID/i)

        const noAuth = managerWith(undefined)
        const profile = noAuth.create({ name: 'SP', config: spConfig, secret: 's' })
        await expect(noAuth.resolveSecret(profile)).rejects.toThrow()
      })
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
