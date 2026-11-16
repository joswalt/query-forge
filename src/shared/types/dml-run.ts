import type { DmlVerb } from '../dml/dml-statement'
import type { PartitionKeyValue } from './document-writer'

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

/** How many matches `planDml`'s `sample` holds (story 85). */
export const DML_SAMPLE_SIZE = 10

/** A value in the confirmation sample. Explicit about definedness, since
 * an absent property and JSON `null` must read differently and `undefined`
 * doesn't survive the trip to the renderer. */
export type DmlSampleValue = { defined: false } | { defined: true; value: unknown }

/** One `SET` path of an `UPDATE` sample: today's value and what the commit
 * would leave there (`next` undefined: removed, or the expression came back
 * undefined). */
export interface DmlSampleChange {
  /** The path as typed, e.g. `c.address.zip`. */
  target: string
  current: DmlSampleValue
  next: DmlSampleValue
}

/** One match of the confirmation sample: its address and, for `UPDATE`,
 * one change per `SET` in statement order. */
export interface DmlSampleDocument {
  id: string
  partitionKey: PartitionKeyValue
  changes?: DmlSampleChange[]
}

/**
 * `planDml`'s result. `planId` is present only when a DML Plan is held, so
 * zero matches (nothing to confirm) comes back without one. `sample` is
 * the first `DML_SAMPLE_SIZE` matches; `partitionKeyPaths` (one per level
 * of each sample's `partitionKey`) names its address columns.
 */
export interface DmlPlanSummary {
  planId?: string
  verb: DmlVerb
  matchCount: number
  drivingQueryRequestCharge: number
  partitionKeyPaths: string[]
  sample: DmlSampleDocument[]
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

/** A Write Outcome's plain label (spec "Renderer DML run state"), shared
 * by the run report and the Query History stats line. */
export function writeOutcomeLabel(outcome: WriteOutcome, verb: DmlVerb): string {
  switch (outcome) {
    case 'written':
      return verb === 'DELETE' ? 'Deleted' : 'Updated'
    case 'unchanged':
      return 'Unchanged'
    case 'concurrent-change':
      return 'Changed by someone else'
    case 'not-found':
      return 'Already deleted'
    case 'expression-undefined':
      return 'SET was undefined'
    case 'failed':
      return 'Failed'
    case 'not-attempted':
      return 'Not attempted'
  }
}

export function emptyOutcomeCounts(): Record<WriteOutcome, number> {
  return Object.fromEntries(WRITE_OUTCOMES.map((o) => [o, 0])) as Record<WriteOutcome, number>
}
