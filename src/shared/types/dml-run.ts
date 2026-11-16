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

/**
 * The Write Outcomes that leave a document not written: every one but
 * `written` and `unchanged`. The one definition behind what a Retry covers,
 * the run report's "Retry N not written" count and a Query History Entry's
 * `partial` status, so the three can't drift apart.
 */
export const NOT_WRITTEN_OUTCOMES: readonly WriteOutcome[] = WRITE_OUTCOMES.filter(
  (outcome) => outcome !== 'written' && outcome !== 'unchanged'
)

export function isNotWritten(outcome: WriteOutcome): boolean {
  return NOT_WRITTEN_OUTCOMES.includes(outcome)
}

/** How many documents a run left not written (`NOT_WRITTEN_OUTCOMES`). */
export function notWrittenCount(counts: Record<WriteOutcome, number>): number {
  return NOT_WRITTEN_OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0)
}

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
  /** Mean stored size in bytes of the documents the Driving Query
   * retrieved (`retrievedDocumentSize / retrievedDocumentCount`). Absent
   * when Cosmos DB returned no query metrics. */
  averageDocumentSize?: number
  partitionKeyPaths: string[]
  sample: DmlSampleDocument[]
}

/** `planRetry`'s result: an ordinary plan result, plus how many documents
 * the Retry re-checked (`scopeCount`). `scopeCount - matchCount` no longer
 * match or were deleted, and are left alone. */
export interface DmlRetrySummary extends DmlPlanSummary {
  scopeCount: number
}

/** Each commit chunk's `meta.dmlProgress`. `requestCharge` is the running
 * write RU (the Driving Query's is in the summary); `counts` the Write
 * Outcomes so far, for the run report's stacked bar. */
export interface DmlCommitProgress {
  completed: number
  total: number
  requestCharge: number
  counts: Record<WriteOutcome, number>
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

/** How a Write Outcome is coloured in the run report: green, amber, red
 * or grey. */
export type WriteOutcomeTone = 'ok' | 'warn' | 'err' | 'muted'

/**
 * How each Write Outcome reads (spec "Renderer DML run state"), in one
 * place: its plain label (the run report and the Query History stats
 * line), its one-line meaning on a run report tile (absent where the label
 * says it all) and its tone.
 */
const WRITE_OUTCOME_DISPLAY: Record<
  WriteOutcome,
  { label: (verb: DmlVerb) => string; meaning?: string; tone: WriteOutcomeTone }
> = {
  written: { label: (verb) => (verb === 'DELETE' ? 'Deleted' : 'Updated'), tone: 'ok' },
  unchanged: {
    label: () => 'Unchanged',
    meaning: 'only removed paths that were already absent; nothing sent',
    tone: 'muted'
  },
  'concurrent-change': {
    label: () => 'Changed by someone else',
    meaning:
      'edited after the plan was made, so skipped. Retry checks it again against its current version',
    tone: 'warn'
  },
  'not-found': { label: () => 'Already deleted', tone: 'muted' },
  'expression-undefined': { label: () => 'SET was undefined', tone: 'warn' },
  failed: { label: () => 'Failed', meaning: 'see message', tone: 'err' },
  'not-attempted': {
    label: () => 'Not attempted',
    meaning: 'the run was cancelled before this write was sent',
    tone: 'muted'
  }
}

export function writeOutcomeLabel(outcome: WriteOutcome, verb: DmlVerb): string {
  return WRITE_OUTCOME_DISPLAY[outcome].label(verb)
}

export function writeOutcomeMeaning(outcome: WriteOutcome): string | undefined {
  return WRITE_OUTCOME_DISPLAY[outcome].meaning
}

export function writeOutcomeTone(outcome: WriteOutcome): WriteOutcomeTone {
  return WRITE_OUTCOME_DISPLAY[outcome].tone
}

export function emptyOutcomeCounts(): Record<WriteOutcome, number> {
  return Object.fromEntries(WRITE_OUTCOMES.map((o) => [o, 0])) as Record<WriteOutcome, number>
}
