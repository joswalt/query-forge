import { WRITE_OUTCOMES, type WriteOutcome } from '@shared/types/dml-run'

/** How a Write Outcome is coloured in the run report (spec "Renderer DML
 * run state"): green, amber, red, or grey; `pending` is the grey part of
 * the bar still to come. */
export type OutcomeTone = 'ok' | 'warn' | 'err' | 'muted' | 'pending'

export function writeOutcomeTone(outcome: WriteOutcome): Exclude<OutcomeTone, 'pending'> {
  switch (outcome) {
    case 'written':
      return 'ok'
    case 'concurrent-change':
    case 'expression-undefined':
      return 'warn'
    case 'failed':
      return 'err'
    default:
      return 'muted'
  }
}

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

/** Documents a run left without being written or left unchanged: what the
 * re-run hint is about. */
export function notWrittenCount(counts: Record<WriteOutcome, number>): number {
  return WRITE_OUTCOMES.filter((o) => o !== 'written' && o !== 'unchanged').reduce(
    (sum, o) => sum + counts[o],
    0
  )
}
