import type { DmlVerb } from '../dml/dml-statement'

/**
 * What happened to one document of a committed DML Plan (GLOSSARY.md:
 * "Write Outcome"). Every document ends with exactly one. On `DELETE` a
 * document already gone (404) is `written`.
 */
export type WriteOutcome =
  | 'written'
  | 'unchanged'
  | 'concurrent-change'
  | 'not-found'
  | 'expression-undefined'
  | 'failed'
  | 'not-attempted'

export const WRITE_OUTCOMES: readonly WriteOutcome[] = [
  'written',
  'unchanged',
  'concurrent-change',
  'not-found',
  'expression-undefined',
  'failed',
  'not-attempted'
]

/** The ceiling on documents in one DML Plan (= `MAX_DISPLAY_ROWS`, so every
 * outcome row stays visible). The Driving Query stops at one more and the
 * run is refused before any write. */
export const MAX_DML_PLAN_DOCUMENTS = 50_000

/** Point Document Writes a commit keeps in flight at once. */
export const DML_WRITE_POOL_SIZE = 8

/** Progress of a running `planDml`: matches found so far and the Driving
 * Query's RU charge so far. */
export interface DmlPlanningProgress {
  matched: number
  requestCharge: number
}

/**
 * `planDml`'s result. `planId` is present only when a DML Plan is held, so
 * zero matches (nothing to confirm) comes back without one.
 */
export interface DmlPlanSummary {
  planId?: string
  verb: DmlVerb
  matchCount: number
  drivingQueryRequestCharge: number
}

/** Each commit chunk's `meta.dmlProgress`. `requestCharge` is the running
 * write RU (the Driving Query's is in the summary). */
export interface DmlCommitProgress {
  completed: number
  total: number
  requestCharge: number
}

/** The last commit chunk's `meta.dmlSummary`. */
export interface DmlCommitSummary {
  verb: DmlVerb
  counts: Record<WriteOutcome, number>
  drivingQueryRequestCharge: number
  writeRequestCharge: number
  durationMs: number
  cancelled: boolean
}

/** One outcome row of a commit's Result Set: `id`, one column per
 * partition key level, `outcome`, `requestCharge`, `message`. */
export type DmlOutcomeRow = Record<string, unknown> & {
  id: string
  outcome: WriteOutcome
  requestCharge: number
  message: string
}

export function emptyOutcomeCounts(): Record<WriteOutcome, number> {
  return Object.fromEntries(WRITE_OUTCOMES.map((o) => [o, 0])) as Record<WriteOutcome, number>
}
