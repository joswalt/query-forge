import { describe, expect, it } from 'vitest'
import { classifyFailureStatus, toRecordQueryHistoryInput } from './query-execution-ipc'

describe('classifyFailureStatus', () => {
  it('reports cancelled when the execution was already known-cancelled', () => {
    expect(classifyFailureStatus(true)).toBe('cancelled')
  })

  it('reports error when the execution was not asked to cancel', () => {
    expect(classifyFailureStatus(false)).toBe('error')
  })
})

describe('toRecordQueryHistoryInput', () => {
  const baseInput = {
    profileId: 'profile-1',
    query: 'SELECT * FROM orders',
    status: 'success' as const,
    startedAt: 1_000,
    rowCount: 7
  }

  it('withholds query text when the preference is off (user story 53 default)', () => {
    const result = toRecordQueryHistoryInput(baseInput, 'Orders (prod)', false, 1_100)

    expect(result.queryText).toBeUndefined()
  })

  it('includes query text only when the preference has opted in', () => {
    const result = toRecordQueryHistoryInput(baseInput, 'Orders (prod)', true, 1_100)

    expect(result.queryText).toBe('SELECT * FROM orders')
  })

  it('computes duration from startedAt to the given finishedAt', () => {
    const result = toRecordQueryHistoryInput(baseInput, 'Orders (prod)', false, 1_250)

    expect(result.durationMs).toBe(250)
  })

  it('falls back to a placeholder profile name when the profile is gone', () => {
    const result = toRecordQueryHistoryInput(baseInput, undefined, false, 1_100)

    expect(result.profileName).toBe('(deleted connection)')
  })

  it('carries status, row count, and error message through unchanged', () => {
    const result = toRecordQueryHistoryInput(
      { ...baseInput, status: 'error', errorMessage: 'Invalid column name' },
      'Orders (prod)',
      false,
      1_100
    )

    expect(result.status).toBe('error')
    expect(result.rowCount).toBe(7)
    expect(result.errorMessage).toBe('Invalid column name')
  })
})
