import { detectDmlStatement, type DmlVerb } from '@shared/dml/dml-statement'
import {
  emptyOutcomeCounts,
  type DmlCommitProgress,
  type DmlCommitSummary,
  type DmlPlanningProgress
} from '@shared/types/dml-run'
import type {
  QueryHistoryStatus,
  RecordQueryHistoryInput
} from '../local-storage/query-history-repository'

/** A DML Statement run as main sees it when planning starts. */
export interface DmlRunTarget {
  profileId: string
  statement: string
  databaseName: string | undefined
  containerName: string | undefined
  /** A Retry of an earlier run (set by the Retry slice). */
  retry?: boolean
}

/** What main keeps about a DML Statement run between its plan and its
 * commit (never document ids or values). */
export interface PlannedDmlRun extends DmlRunTarget {
  verb: DmlVerb
  matchCount: number
  drivingQueryRequestCharge: number
  planningDurationMs: number
}

/** Planning that ended without a held plan: it failed (refused, parse
 * error, ceiling, Driving Query error, or cancelled), or nothing matched. */
export type PlanningEnding =
  | { kind: 'no-matches'; verb: DmlVerb; drivingQueryRequestCharge: number }
  | { kind: 'failed'; wasCancelled: boolean; message: string; progress?: DmlPlanningProgress }

export type CommitEnding =
  | { kind: 'ended'; summary: DmlCommitSummary }
  | { kind: 'failed'; wasCancelled: boolean; message: string; progress?: DmlCommitProgress }

export interface DmlHistoryContext {
  profileName: string | undefined
  persistQueryText: boolean
}

/** Same placeholder as a query entry for a profile deleted mid-run. */
const DELETED_PROFILE_NAME = '(deleted connection)'

/** Write Outcomes that leave a document not written by a commit that ran
 * to the end (`written` and `unchanged` count as done). */
const UNWRITTEN_OUTCOMES = [
  'concurrent-change',
  'not-found',
  'expression-undefined',
  'failed'
] as const

/**
 * The Query History input for planning that ended without a plan: `error`
 * (or `cancelled`), or `success` with nothing matched. Timed and dated
 * from planning start. The verb comes from the statement text, since a
 * failed plan reports none.
 */
export function planningEndedHistoryInput(
  run: DmlRunTarget,
  ending: PlanningEnding,
  times: { startedAt: number; finishedAt: number },
  context: DmlHistoryContext
): RecordQueryHistoryInput {
  const failed = ending.kind === 'failed'
  const status: QueryHistoryStatus = failed
    ? ending.wasCancelled
      ? 'cancelled'
      : 'error'
    : 'success'
  return {
    profileId: run.profileId,
    profileName: context.profileName ?? DELETED_PROFILE_NAME,
    queryText: context.persistQueryText ? run.statement : undefined,
    status,
    durationMs: times.finishedAt - times.startedAt,
    rowCount: failed ? undefined : 0,
    errorMessage: failed && status === 'error' ? ending.message : undefined,
    executedAt: new Date(times.startedAt).toISOString(),
    dml: {
      verb: failed ? detectDmlStatement(run.statement) : ending.verb,
      databaseName: run.databaseName,
      containerName: run.containerName,
      counts: emptyOutcomeCounts(),
      totalRequestCharge: failed
        ? (ending.progress?.requestCharge ?? 0)
        : ending.drivingQueryRequestCharge,
      retry: run.retry ?? false
    }
  }
}

/**
 * The Query History input for a commit that ended, however it ended. Dated
 * from commit start; timed as planning plus commit.
 */
export function commitEndedHistoryInput(
  plan: PlannedDmlRun,
  ending: CommitEnding,
  times: { startedAt: number; finishedAt: number },
  context: DmlHistoryContext
): RecordQueryHistoryInput {
  const status = commitStatus(ending)
  const reported =
    ending.kind === 'ended'
      ? {
          counts: ending.summary.counts,
          totalRequestCharge:
            ending.summary.drivingQueryRequestCharge + ending.summary.writeRequestCharge
        }
      : {
          counts: ending.progress?.counts ?? emptyOutcomeCounts(),
          totalRequestCharge: plan.drivingQueryRequestCharge + (ending.progress?.requestCharge ?? 0)
        }
  return {
    profileId: plan.profileId,
    profileName: context.profileName ?? DELETED_PROFILE_NAME,
    queryText: context.persistQueryText ? plan.statement : undefined,
    status,
    // Planning plus commit: the wait at the confirmation is left out.
    durationMs: plan.planningDurationMs + (times.finishedAt - times.startedAt),
    rowCount: plan.matchCount,
    errorMessage: ending.kind === 'failed' && status === 'error' ? ending.message : undefined,
    executedAt: new Date(times.startedAt).toISOString(),
    dml: {
      verb: plan.verb,
      databaseName: plan.databaseName,
      containerName: plan.containerName,
      counts: { ...reported.counts },
      totalRequestCharge: reported.totalRequestCharge,
      retry: plan.retry ?? false
    }
  }
}

/** `cancelled` wins when the commit was stopped; `error` when it could not
 * run; `partial` when it ran to the end but left documents unwritten. */
function commitStatus(ending: CommitEnding): QueryHistoryStatus {
  if (ending.kind === 'failed') return ending.wasCancelled ? 'cancelled' : 'error'
  const { counts, cancelled } = ending.summary
  if (cancelled) return 'cancelled'
  return UNWRITTEN_OUTCOMES.some((o) => counts[o] > 0) ? 'partial' : 'success'
}
