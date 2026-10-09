import { describe, expect, it, beforeEach } from 'vitest'
import { createTestDb } from '../local-storage/test-support/create-test-db'
import { MsalTokenCacheRepository } from '../local-storage/msal-token-cache-repository'
import type { SecretStore } from './secret-store'
import { SqliteTokenCacheStore } from './sqlite-token-cache-store'

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

describe('SqliteTokenCacheStore', () => {
  let repository: MsalTokenCacheRepository
  let secretStore: SecretStore

  beforeEach(() => {
    repository = new MsalTokenCacheRepository(createTestDb())
    secretStore = new ReversingSecretStore()
  })

  it('returns undefined when no cache has been stored yet', () => {
    const store = new SqliteTokenCacheStore(repository, secretStore, 'profile-1')

    expect(store.read()).toBeUndefined()
  })

  it('round-trips a serialized cache through encryption', () => {
    const store = new SqliteTokenCacheStore(repository, secretStore, 'profile-1')

    store.write('{"accounts":{}}')

    expect(store.read()).toBe('{"accounts":{}}')
  })

  it('never stores the cache as plaintext', () => {
    const store = new SqliteTokenCacheStore(repository, secretStore, 'profile-1')
    store.write('plaintext-marker')

    const rawCiphertext = repository.get('profile-1')

    expect(rawCiphertext?.toString('utf-8')).not.toBe('plaintext-marker')
  })

  it('keeps caches for different profiles independent', () => {
    const storeA = new SqliteTokenCacheStore(repository, secretStore, 'profile-a')
    const storeB = new SqliteTokenCacheStore(repository, secretStore, 'profile-b')

    storeA.write('cache-a')
    storeB.write('cache-b')

    expect(storeA.read()).toBe('cache-a')
    expect(storeB.read()).toBe('cache-b')
  })
})
