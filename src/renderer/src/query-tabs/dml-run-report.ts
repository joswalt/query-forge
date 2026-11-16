import {
  WRITE_OUTCOMES,
  writeOutcomeTone,
  type WriteOutcome,
  type WriteOutcomeTone
} from '@shared/types/dml-run'

/** A bar segment's tone: a Write Outcome's, or `pending`, the grey part of
 * the bar still to come. */
export type OutcomeTone = WriteOutcomeTone | 'pending'

export interface OutcomeBarSegment {
  key: WriteOutcome | 'pending'
  tone: OutcomeTone
  count: number
}

/**
 * The run report's one stacked bar (story 100): a segment per non-zero
 * Write Outcome in the usual order, then the documents still to come.
 * Widths are each `count / total`.
 */
export function outcomeBarSegments(
  counts: Record<WriteOutcome, number>,
  total: number
): OutcomeBarSegment[] {
  const segments: OutcomeBarSegment[] = WRITE_OUTCOMES.filter((o) => counts[o] > 0).map((o) => ({
    key: o,
    tone: writeOutcomeTone(o),
    count: counts[o]
  }))
  const reported = segments.reduce((sum, s) => sum + s.count, 0)
  if (total > reported) segments.push({ key: 'pending', tone: 'pending', count: total - reported })
  return segments
}
