import type { ResultChunk } from '@shared/types/database-provider'
import {
  dmlAfterDone,
  dmlAfterFailure,
  withCommitChunkMeta,
  type DmlRunAction,
  type DmlRunState
} from './dml-run-state'

/**
 * Upper bound on rows retained for display per query run, summed across all
 * of its Result Sets (user story 31:
 * large result sets must not exhaust memory). The results/export slice
 * made the grid virtualized (TanStack Virtual only renders visible rows),
 * which removes the *rendering-cost* reason for a cap, but the renderer
 * still holds every retained row as plain JS objects in memory — the cap
 * stays for that reason. `rowCount` (per Result Set and overall) keeps
 * counting past the cap so the true total is never understated — except for
 * Cosmos DB, where the run itself is limited to this many rows by default
 * (`QueryOptions.maxRows`, so a huge container isn't paged to the end for
 * RUs); then `stoppedAtRowLimit` marks `rowCount` as a lower bound. The
 * per-tab Row Limit dropdown changes (or, with "All rows", lifts) that limit. The cap is
 * shared, so in a multi-statement script a huge first Result Set can leave
 * later ones with no retained rows — their `rowCount` still shows.
 *
 * This cap is also the exact boundary of "export loaded rows" (user story
 * 45): exporting "loaded" rows exports precisely what's in `rows` here,
 * capped at `MAX_DISPLAY_ROWS` — it is not a snapshot of everything the
 * query has produced so far. "Export all matching rows" (user story 46)
 * is a deliberately separate path that re-executes the query in main,
 * uncapped, and never touches this renderer-side array — see
 * src/main/export/export-service.ts.
 */
export const MAX_DISPLAY_ROWS = 50_000

export type QueryRunStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled'

/** One Result Set (GLOSSARY.md) of a run — the output of one row-returning
 * statement. A single-statement query (and every Cosmos query) has exactly one. */
export interface ResultSetState {
  /** Rows retained for display (see `MAX_DISPLAY_ROWS`, a cap shared by all sets). */
  rows: unknown[]
  /** True row count of this set, uncapped. */
  rowCount: number
}

export interface QueryRunState {
  status: QueryRunStatus
  /** Result Sets seen so far, in statement order. Empty until the first chunk. */
  resultSets: ResultSetState[]
  /** True cumulative row count across all chunks and Result Sets, uncapped. */
  rowCount: number
  /** Summed Cosmos RU charge (user story 35) — stays `undefined` if no
   * chunk ever reported one (Azure SQL never does), never collapses to 0. */
  ruTotal: number | undefined
  /** True when the Provider stopped at `QueryOptions.maxRows` with rows left
   * behind (Cosmos DB). Then `rowCount` is a lower bound, not the true total. */
  stoppedAtRowLimit: boolean
  startedAt: number | undefined
  finishedAt: number | undefined
  /** Set only for a genuine failure, never for a user-requested cancel. */
  errorMessage: string | undefined
  /** Set while (and after) the run is a Cosmos DB DML Statement: its phase
   * from planning to done (see dml-run-state.ts). Undefined for a query. */
  dml?: DmlRunState
}

export const initialQueryRunState: QueryRunState = {
  status: 'idle',
  resultSets: [],
  rowCount: 0,
  ruTotal: undefined,
  stoppedAtRowLimit: false,
  startedAt: undefined,
  finishedAt: undefined,
  errorMessage: undefined
}

export type QueryRunAction =
  | { type: 'started'; startedAt: number }
  | { type: 'chunk'; chunk: ResultChunk }
  | { type: 'done'; finishedAt: number }
  | {
      type: 'failed'
      message: string
      finishedAt: number
      /** Whether this failure was caused by the user's own `cancel()` call
       * rather than a genuine provider error — asymmetric per provider
       * (Azure SQL: TDS Attention via `Request.cancel()`; Cosmos DB:
       * `AbortSignal`), but from the UI's perspective both simply surface
       * as the async iterator throwing. Distinguishing "cancelled" from
       * "error" is the caller's job (it knows whether it called cancel),
       * not this reducer's — see GLOSSARY.md: Execution ID.
       */
      cancelled: boolean
    }
  | DmlRunAction

/**
 * Pure state machine for one query tab's in-flight/most-recent execution.
 * Deliberately has no dependency on IPC, CodeMirror, or React — the
 * TDD seam for this slice (per `implement` skill guidance), testable with
 * plain Vitest and no jsdom.
 */
export function queryRunReducer(state: QueryRunState, action: QueryRunAction): QueryRunState {
  switch (action.type) {
    case 'started':
      return { ...initialQueryRunState, status: 'running', startedAt: action.startedAt }

    case 'chunk': {
      const ru = action.chunk.meta?.ru
      const index = action.chunk.resultSet ?? 0
      // Pad to `index` so a set announced out of order still lands in its slot.
      const resultSets = [...state.resultSets]
      while (resultSets.length <= index) resultSets.push({ rows: [], rowCount: 0 })

      const room = Math.max(MAX_DISPLAY_ROWS - retainedRowCount(state), 0)
      const target = resultSets[index]
      resultSets[index] = {
        rows: room === 0 ? target.rows : [...target.rows, ...action.chunk.rows.slice(0, room)],
        rowCount: target.rowCount + action.chunk.rows.length
      }
      return {
        ...state,
        resultSets,
        rowCount: state.rowCount + action.chunk.rows.length,
        ruTotal: ru === undefined ? state.ruTotal : (state.ruTotal ?? 0) + ru,
        stoppedAtRowLimit: state.stoppedAtRowLimit || action.chunk.meta?.truncated === true,
        dml: withCommitChunkMeta(state.dml, action.chunk.meta)
      }
    }

    case 'done': {
      const dml = dmlAfterDone(state.dml)
      return {
        ...state,
        status: dml?.phase === 'stopped' ? 'cancelled' : 'success',
        finishedAt: action.finishedAt,
        dml
      }
    }

    case 'failed':
      return {
        ...state,
        status: action.cancelled ? 'cancelled' : 'error',
        finishedAt: action.finishedAt,
        errorMessage: action.cancelled ? undefined : action.message,
        dml: dmlAfterFailure(state.dml, action.cancelled)
      }

    case 'dmlPlanningStarted':
      return {
        ...initialQueryRunState,
        status: 'running',
        startedAt: action.startedAt,
        dml: {
          phase: 'planning',
          verb: action.verb,
          container: action.container,
          matched: 0,
          requestCharge: 0
        }
      }

    case 'dmlPlanningProgress':
      if (state.dml?.phase !== 'planning') return state
      return {
        ...state,
        dml: {
          ...state.dml,
          matched: action.progress.matched,
          requestCharge: action.progress.requestCharge
        }
      }

    case 'dmlPlanned': {
      if (state.dml?.phase !== 'planning') return state
      const { verb, container } = state.dml
      const { planId, matchCount, drivingQueryRequestCharge, partitionKeyPaths, sample } =
        action.summary
      if (planId === undefined || matchCount === 0) {
        return {
          ...state,
          status: 'success',
          finishedAt: action.at,
          dml: { phase: 'zero-matches', verb, container, drivingQueryRequestCharge }
        }
      }
      return {
        ...state,
        dml: {
          phase: 'confirming',
          verb,
          container,
          planId,
          matchCount,
          drivingQueryRequestCharge,
          partitionKeyPaths,
          sample
        }
      }
    }

    case 'dmlDiscarded':
      if (state.dml?.phase !== 'confirming') return state
      return {
        ...state,
        status: 'cancelled',
        finishedAt: action.finishedAt,
        dml: { phase: 'discarded', verb: state.dml.verb, container: state.dml.container }
      }

    case 'dmlCommitStarted': {
      if (state.dml?.phase !== 'confirming') return state
      const { verb, container, matchCount, drivingQueryRequestCharge } = state.dml
      return {
        ...state,
        dml: {
          phase: 'committing',
          verb,
          container,
          matchCount,
          drivingQueryRequestCharge,
          progress: { completed: 0, total: matchCount, requestCharge: 0 },
          stopRequested: false,
          summary: undefined
        }
      }
    }

    case 'dmlStopRequested':
      if (state.dml?.phase !== 'committing') return state
      return { ...state, dml: { ...state.dml, stopRequested: true } }

    default:
      return state
  }
}

/** Rows currently held for display, across every Result Set. */
export function retainedRowCount(state: QueryRunState): number {
  return state.resultSets.reduce((total, set) => total + set.rows.length, 0)
}
