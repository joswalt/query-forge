import { describe, expect, it } from 'vitest'
import { formatLastUsed } from './last-used'

const now = new Date('2026-10-27T12:00:00Z')
const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatLastUsed', () => {
  it('says "just now" under a minute', () => {
    expect(formatLastUsed(ago(30_000), now)).toBe('last used just now')
  })

  it('uses minutes, hours, and days', () => {
    expect(formatLastUsed(ago(5 * MINUTE), now)).toBe('last used 5m ago')
    expect(formatLastUsed(ago(2 * HOUR + 10 * MINUTE), now)).toBe('last used 2h ago')
    expect(formatLastUsed(ago(1 * DAY), now)).toBe('last used yesterday')
    expect(formatLastUsed(ago(6 * DAY), now)).toBe('last used 6d ago')
  })

  it('falls back to a calendar date after a week', () => {
    expect(formatLastUsed('2026-09-03T12:00:00Z', now)).toBe('last used Sep 3')
  })

  it('includes the year when it differs', () => {
    expect(formatLastUsed('2025-12-30T12:00:00Z', now)).toBe('last used Dec 30, 2025')
  })

  it('treats a clock-skewed future timestamp as just now', () => {
    expect(formatLastUsed(ago(-5 * MINUTE), now)).toBe('last used just now')
  })
})
