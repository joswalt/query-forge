import { describe, expect, it } from 'vitest'
import { remoteErrorMessage } from './remote-error'

describe('remoteErrorMessage', () => {
  it("drops Electron's invoke wrapper, keeping main's scrubbed message", () => {
    const err = new Error(
      "Error invoking remote method 'document:write': Error: Request rate is large. Retry after 120ms"
    )
    expect(remoteErrorMessage(err)).toBe('Request rate is large. Retry after 120ms')
  })

  it('keeps a message without the wrapper, and stringifies non-errors', () => {
    expect(remoteErrorMessage(new Error('Profile is read-only'))).toBe('Profile is read-only')
    expect(remoteErrorMessage('boom')).toBe('boom')
  })
})
