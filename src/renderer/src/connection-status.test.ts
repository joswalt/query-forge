import { describe, expect, it } from 'vitest'
import { markConnectionsLost, type ConnectionStatus } from './connection-status'

describe('markConnectionsLost', () => {
  it('turns connected profiles into error and leaves other statuses alone', () => {
    const before: Record<string, ConnectionStatus> = {
      a: 'connected',
      b: 'disconnected',
      c: 'connecting',
      d: 'error'
    }
    expect(markConnectionsLost(before)).toEqual({
      a: 'error',
      b: 'disconnected',
      c: 'connecting',
      d: 'error'
    })
  })

  it('does not mutate its input', () => {
    const before: Record<string, ConnectionStatus> = { a: 'connected' }
    markConnectionsLost(before)
    expect(before).toEqual({ a: 'connected' })
  })
})
