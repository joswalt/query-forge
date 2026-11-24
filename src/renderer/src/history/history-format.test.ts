import { describe, expect, it } from 'vitest'
import {
  firstQueryLine,
  formatDuration,
  formatRowCount,
  groupHistoryByDay,
  historyDayLabel
} from './history-format'

// Local-time constructors, so the calendar-day rules hold in any timezone.
const now = new Date(2026, 10, 24, 15, 0) // Tue Nov 24 2026, 3 PM
const at = (y: number, m: number, d: number, h = 12): string => new Date(y, m, d, h).toISOString()

describe('historyDayLabel', () => {
  it('names today and yesterday by calendar day, not by 24h span', () => {
    expect(historyDayLabel(at(2026, 10, 24, 0), now)).toBe('Today')
    expect(historyDayLabel(at(2026, 10, 23, 23), now)).toBe('Yesterday')
  })

  it('uses the weekday within the last week', () => {
    expect(historyDayLabel(at(2026, 10, 19), now)).toBe('Thursday')
  })

  it('uses a short date after a week, with the year only when it differs', () => {
    expect(historyDayLabel(at(2026, 10, 10), now)).toBe('Nov 10')
    expect(historyDayLabel(at(2025, 10, 10), now)).toBe('Nov 10, 2025')
  })
})

describe('groupHistoryByDay', () => {
  it('keeps order and groups consecutive entries under one label', () => {
    const entries = [
      { id: 'a', executedAt: at(2026, 10, 24, 14) },
      { id: 'b', executedAt: at(2026, 10, 24, 9) },
      { id: 'c', executedAt: at(2026, 10, 23) }
    ]

    expect(groupHistoryByDay(entries, now).map((d) => [d.label, d.entries.map((e) => e.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']]
    ])
  })
})

describe('formatDuration', () => {
  it('shows milliseconds under a second and seconds after', () => {
    expect(formatDuration(412)).toBe('412 ms')
    expect(formatDuration(1203)).toBe('1.2 s')
  })
})

describe('formatRowCount', () => {
  it('groups thousands and singularises one row', () => {
    expect(formatRowCount(5321)).toBe('5,321 rows')
    expect(formatRowCount(1)).toBe('1 row')
  })
})

describe('firstQueryLine', () => {
  it('skips blank lines and trims', () => {
    expect(firstQueryLine('\n  SELECT *\nFROM c')).toBe('SELECT *')
  })
})
