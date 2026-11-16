import type { DmlVerb } from '@shared/dml/dml-statement'
import type {
  DmlCommitProgress,
  DmlCommitSummary,
  DmlPlanningProgress,
  DmlPlanSummary,
  DmlRetrySummary,
  DmlSampleDocument
} from '@shared/types/dml-run'
import { notWrittenCount } from '@shared/types/dml-run'

/**
 * The DML phases of one tab's run (spec "Renderer DML run state"),
 * alongside `QueryRunState.status`. The tab is busy (status `running`)
 * from planning through committing, confirming included. Planning that
 * ends without a plan because the user cancelled lands on `discarded`,
 * since nothing was written either way.
 *
 * A Retry (GLOSSARY.md) has its own variants: planning, confirming and
 * zero matches carry `retry.scopeCount` (the documents re-checked), and
 * committing, done and stopped carry `retry: true`.
 */
export type DmlRunState =
  | {
      phase: 'planning'
      verb: DmlVerb
      container: string
      /** The statement text as planned; the editor may change meanwhile.
       * A Retry's is the original run's. */
      statement: string
      matched: number
      requestCharge: number
      retry?: RetryScope
    }
  | {
      phase: 'confirming'
      verb: DmlVerb
      container: string
      /** What "Preview as query" reads its `WHERE` from. */
      statement: string
      planId: string
      matchCount: number
      drivingQueryRequestCharge: number
      /** For the rough write-RU band; absent without query metrics. */
      averageDocumentSize?: number
      /** Names the address columns of `sample`. */
      partitionKeyPaths: string[]
      /** The first matches, shown under "WILL DELETE / WILL UPDATE". */
      sample: DmlSampleDocument[]
      retry?: RetryScope
    }
  | {
      phase: 'committing'
      verb: DmlVerb
      container: string
      statement: string
      planId: string
      matchCount: number
      drivingQueryRequestCharge: number
      progress: DmlCommitProgress
      stopRequested: boolean
      /** From the last chunk's `meta`, until the commit's `done`. */
      summary: DmlCommitSummary | undefined
      retry?: true
    }
  | {
      phase: 'done' | 'stopped'
      verb: DmlVerb
      container: string
      statement: string
      /** The committed plan, which a Retry names: the tab's last committed
       * run. Absent once the Query Execution Service dropped it. */
      planId?: string
      matchCount: number
      summary: DmlCommitSummary
      retry?: true
      /** Why the last Retry of this run could not be planned. */
      retryError?: string
    }
  | { phase: 'discarded'; verb: DmlVerb; container: string }
  | {
      phase: 'zero-matches'
      verb: DmlVerb
      container: string
      drivingQueryRequestCharge: number
      retry?: RetryScope
    }
  | { phase: 'error'; verb: DmlVerb; container: string; stage: 'planning' | 'committing' }

/** A Retry's scope: how many documents of the last run it re-checks. */
export interface RetryScope {
  scopeCount: number
}

export type DmlRunAction =
  | {
      type: 'dmlPlanningStarted'
      startedAt: number
      verb: DmlVerb
      container: string
      statement: string
    }
  | { type: 'dmlPlanningProgress'; progress: DmlPlanningProgress }
  | { type: 'dmlPlanned'; summary: DmlPlanSummary | DmlRetrySummary; at: number }
  /** "Retry N not written" on a finished or stopped run report. */
  | { type: 'dmlRetryPlanningStarted'; startedAt: number }
  /** The Query Execution Service no longer holds the tab's last committed
   * run (its connection closed), so it can't be retried. */
  | { type: 'dmlLastRunDropped' }
  | { type: 'dmlDiscarded'; finishedAt: number }
  | { type: 'dmlCommitStarted' }
  | { type: 'dmlStopRequested' }

/** Folds a commit chunk's `meta` into the committing phase. */
export function withCommitChunkMeta(
  dml: DmlRunState | undefined,
  meta: { dmlProgress?: DmlCommitProgress; dmlSummary?: DmlCommitSummary } | undefined
): DmlRunState | undefined {
  if (dml?.phase !== 'committing') return dml
  return {
    ...dml,
    progress: meta?.dmlProgress ?? dml.progress,
    summary: meta?.dmlSummary ?? dml.summary
  }
}

/** The DML phase after the run's stream ended normally. */
export function dmlAfterDone(dml: DmlRunState | undefined): DmlRunState | undefined {
  if (dml?.phase !== 'committing' || !dml.summary) return dml
  return {
    phase: dml.summary.cancelled ? 'stopped' : 'done',
    verb: dml.verb,
    container: dml.container,
    statement: dml.statement,
    planId: dml.planId,
    matchCount: dml.matchCount,
    summary: dml.summary,
    ...(dml.retry ? { retry: true as const } : {})
  }
}

/**
 * How many documents "Retry N not written" would re-check (stories 115,
 * 126): only on a finished or stopped run report whose last committed run
 * is still held, counting every document not `written` or `unchanged`.
 * Undefined when no Retry is offered.
 */
export function retryScope(dml: DmlRunState | undefined): number | undefined {
  if ((dml?.phase !== 'done' && dml?.phase !== 'stopped') || dml.planId === undefined) {
    return undefined
  }
  const count = notWrittenCount(dml.summary.counts)
  return count > 0 ? count : undefined
}

/** The DML phase after the run failed or was cancelled. */
export function dmlAfterFailure(
  dml: DmlRunState | undefined,
  cancelled: boolean
): DmlRunState | undefined {
  if (dml?.phase === 'planning') {
    return cancelled
      ? { phase: 'discarded', verb: dml.verb, container: dml.container }
      : { phase: 'error', verb: dml.verb, container: dml.container, stage: 'planning' }
  }
  if (dml?.phase === 'committing') {
    return { phase: 'error', verb: dml.verb, container: dml.container, stage: 'committing' }
  }
  return dml
}
