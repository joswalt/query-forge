import { describe, expect, it } from 'vitest'
import {
  isNetworkInterruption,
  toConnectionErrorMessage,
  toExecutionErrorMessage,
  toSafeErrorMessage
} from './scrub-error-message'

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

function coded(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code })
}

describe('isNetworkInterruption', () => {
  it.each(['ESOCKET', 'ECONNRESET', 'ECONNCLOSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'])(
    'detects %s',
    (code) => {
      expect(isNetworkInterruption(coded(code))).toBe(true)
    }
  )

  it('detects a code on a nested cause', () => {
    expect(isNetworkInterruption(new Error('fetch failed', { cause: coded('ECONNRESET') }))).toBe(
      true
    )
  })

  it.each(['ECANCEL', 'ETIMEOUT', 'EREQUEST'])('does not treat %s as a network drop', (code) => {
    expect(isNetworkInterruption(coded(code))).toBe(false)
  })

  it('does not treat an AbortError or plain error as a network drop', () => {
    expect(isNetworkInterruption(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false)
    expect(isNetworkInterruption(new Error('x'))).toBe(false)
    expect(isNetworkInterruption('ECONNRESET')).toBe(false)
  })
})

describe('toExecutionErrorMessage', () => {
  it('rewrites a network interruption with a retry/reconnect hint and scrubs it', () => {
    const message = toExecutionErrorMessage(coded('ECONNRESET', 'read failed; password=hunter2'))

    expect(message).toContain('interrupted')
    expect(message).toContain('reconnect')
    expect(message).toContain('password=***')
    expect(message).not.toContain('hunter2')
  })

  it('leaves non-network errors as the scrubbed message only', () => {
    expect(toExecutionErrorMessage(coded('ETIMEOUT', 'Timeout: request failed to complete'))).toBe(
      'Timeout: request failed to complete'
    )
  })

  it('is idempotent on its own output', () => {
    const once = toExecutionErrorMessage(coded('ESOCKET'))
    expect(toExecutionErrorMessage(new Error(once))).toBe(once)
  })
})
