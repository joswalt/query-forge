import { describe, expect, it } from 'vitest'
import { toConnectionErrorMessage, toSafeErrorMessage } from './scrub-error-message'

describe('toSafeErrorMessage', () => {
  it('scrubs a password embedded in a driver error message', () => {
    expect(toSafeErrorMessage(new Error('Login failed; password=hunter2;server=x'))).toBe(
      'Login failed; password=***;server=x'
    )
  })
})

describe('toConnectionErrorMessage', () => {
  it('rewrites an entra-id "Login failed" error into a clear re-auth message (user story 62)', () => {
    const message = toConnectionErrorMessage(new Error('Login failed for user token'), 'entra-id')

    expect(message).toContain('Entra ID sign-in has expired or is no longer valid')
    expect(message).toContain('disconnect and reconnect')
  })

  it('rewrites an entra-id AADSTS error into the re-auth message', () => {
    const message = toConnectionErrorMessage(
      new Error('AADSTS700082: The refresh token has expired'),
      'entra-id'
    )

    expect(message).toContain('Entra ID sign-in has expired or is no longer valid')
  })

  it('leaves a non-entra-id error message as the plain scrubbed message', () => {
    const message = toConnectionErrorMessage(
      new Error('Login failed; password=hunter2'),
      'sql-credentials'
    )

    expect(message).toBe('Login failed; password=***')
  })

  it('leaves an entra-id error that does not look like a token problem untouched', () => {
    const message = toConnectionErrorMessage(new Error('ENOTFOUND database.invalid'), 'entra-id')

    expect(message).toBe('ENOTFOUND database.invalid')
  })
})
