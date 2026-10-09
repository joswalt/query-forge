import { describe, expect, it, beforeEach } from 'vitest'
import { createTestDb } from './test-support/create-test-db'
import { MsalTokenCacheRepository } from './msal-token-cache-repository'

describe('MsalTokenCacheRepository', () => {
  let repository: MsalTokenCacheRepository

  beforeEach(() => {
    repository = new MsalTokenCacheRepository(createTestDb())
  })

  it('returns undefined for a profile with no stored cache', () => {
    expect(repository.get('profile-1')).toBeUndefined()
  })

  it('stores and retrieves a cache ciphertext for a profile', () => {
    const ciphertext = Buffer.from('fake-ciphertext')

    repository.set('profile-1', ciphertext)

    expect(repository.get('profile-1')).toEqual(ciphertext)
  })

  it('overwrites a previously stored cache for the same profile', () => {
    repository.set('profile-1', Buffer.from('first'))
    repository.set('profile-1', Buffer.from('second'))

    expect(repository.get('profile-1')).toEqual(Buffer.from('second'))
  })

  it('keeps caches for different profiles independent', () => {
    repository.set('profile-1', Buffer.from('one'))
    repository.set('profile-2', Buffer.from('two'))

    expect(repository.get('profile-1')).toEqual(Buffer.from('one'))
    expect(repository.get('profile-2')).toEqual(Buffer.from('two'))
  })

  it('deletes a stored cache', () => {
    repository.set('profile-1', Buffer.from('one'))

    repository.delete('profile-1')

    expect(repository.get('profile-1')).toBeUndefined()
  })
})
