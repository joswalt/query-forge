import { describe, expect, it } from 'vitest'
import { emptyOutcomeCounts, type WriteOutcome } from '@shared/types/dml-run'
import { notWrittenCount, outcomeBarSegments } from './dml-run-report'

const counts = (values: Partial<Record<WriteOutcome, number>>): Record<WriteOutcome, number> => ({
  ...emptyOutcomeCounts(),
  ...values
})

describe('the run report’s stacked progress and Write Outcome bar', () => {
  it('colours written green, Concurrent Changes and undefined SETs amber, failures red and the rest grey', () => {
    const segments = outcomeBarSegments(
      counts({
        written: 5,
        unchanged: 1,
        'concurrent-change': 2,
        'not-found': 1,
        'expression-undefined': 3,
        failed: 4,
        'not-attempted': 2
      }),
      18
    )

    expect(segments).toEqual([
      { key: 'written', tone: 'ok', count: 5 },
      { key: 'unchanged', tone: 'muted', count: 1 },
      { key: 'concurrent-change', tone: 'warn', count: 2 },
      { key: 'not-found', tone: 'muted', count: 1 },
      { key: 'expression-undefined', tone: 'warn', count: 3 },
      { key: 'failed', tone: 'err', count: 4 },
      { key: 'not-attempted', tone: 'muted', count: 2 }
    ])
  })

  it('shows the part still to come as a grey pending segment, leaving out outcomes nobody has', () => {
    expect(outcomeBarSegments(counts({ written: 820, failed: 3 }), 1840)).toEqual([
      { key: 'written', tone: 'ok', count: 820 },
      { key: 'failed', tone: 'err', count: 3 },
      { key: 'pending', tone: 'pending', count: 1017 }
    ])
  })

  it('is all pending before any write has reported', () => {
    expect(outcomeBarSegments(emptyOutcomeCounts(), 12)).toEqual([
      { key: 'pending', tone: 'pending', count: 12 }
    ])
  })
})

describe('documents a run left unwritten', () => {
  it('counts every Write Outcome except written and unchanged', () => {
    expect(
      notWrittenCount(
        counts({
          written: 100,
          unchanged: 7,
          'concurrent-change': 2,
          'not-found': 1,
          'expression-undefined': 3,
          failed: 4,
          'not-attempted': 5
        })
      )
    ).toBe(15)
  })

  it('is zero when every document was written or left unchanged', () => {
    expect(notWrittenCount(counts({ written: 10, unchanged: 2 }))).toBe(0)
  })
})
