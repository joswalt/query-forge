import type { DmlVerb } from '@shared/dml/dml-statement'
import type {
  DmlCommitProgress,
  DmlCommitSummary,
  DmlPlanningProgress,
  DmlPlanSummary,
  DmlSampleDocument
} from '@shared/types/dml-run'

/**
 * The DML phases of one tab's run (spec "Renderer DML run state"),
 * alongside `QueryRunState.status`. The tab is busy (status `running`)
 * from planning through committing, confirming included. Planning that
 * ends without a plan because the user cancelled lands on `discarded`,
 * since nothing was written either way.
 */
export type DmlRunState =
  | { phase: 'planning'; verb: DmlVerb; container: string; matched: number; requestCharge: number }
  | {
      phase: 'confirming'
      verb: DmlVerb
      container: string
      planId: string
      matchCount: number
      drivingQueryRequestCharge: number
      /** Names the address columns of `sample`. */
      partitionKeyPaths: string[]
      /** The first matches, shown under "WILL DELETE / WILL UPDATE". */
      sample: DmlSampleDocument[]
    }
  | {
      phase: 'committing'
      verb: DmlVerb
      container: string
      matchCount: number
      drivingQueryRequestCharge: number
      progress: DmlCommitProgress
      stopRequested: boolean
      /** From the last chunk's `meta`, until the commit's `done`. */
      summary: DmlCommitSummary | undefined
    }
  | {
      phase: 'done' | 'stopped'
      verb: DmlVerb
      container: string
      matchCount: number
      summary: DmlCommitSummary
    }
  | { phase: 'discarded'; verb: DmlVerb; container: string }
  | { phase: 'zero-matches'; verb: DmlVerb; container: string; drivingQueryRequestCharge: number }
  | { phase: 'error'; verb: DmlVerb; container: string; stage: 'planning' | 'committing' }

export type DmlRunAction =
  | { type: 'dmlPlanningStarted'; startedAt: number; verb: DmlVerb; container: string }
  | { type: 'dmlPlanningProgress'; progress: DmlPlanningProgress }
  | { type: 'dmlPlanned'; summary: DmlPlanSummary; at: number }
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
    matchCount: dml.matchCount,
    summary: dml.summary
  }
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
