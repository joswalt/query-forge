import type { ResultChunk } from '@shared/types/database-provider'

/**
 * Upper bound on rows retained for display per query run, summed across all
 * of its Result Sets (user story 31:
 * large result sets must not exhaust memory). The results/export slice
 * made the grid virtualized (TanStack Virtual only renders visible rows),
 * which removes the *rendering-cost* reason for a cap, but the renderer
 * still holds every retained row as plain JS objects in memory — the cap
 * stays for that reason. `rowCount` (per Result Set and overall) keeps
 * counting past the cap so the true total is never understated. The cap is
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
  startedAt: number | undefined
  finishedAt: number | undefined
  /** Set only for a genuine failure, never for a user-requested cancel. */
  errorMessage: string | undefined
}

export const initialQueryRunState: QueryRunState = {
  status: 'idle',
  resultSets: [],
  rowCount: 0,
  ruTotal: undefined,
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
        ruTotal: ru === undefined ? state.ruTotal : (state.ruTotal ?? 0) + ru
      }
    }

    case 'done':
      return { ...state, status: 'success', finishedAt: action.finishedAt }

    case 'failed':
      return {
        ...state,
        status: action.cancelled ? 'cancelled' : 'error',
        finishedAt: action.finishedAt,
        errorMessage: action.cancelled ? undefined : action.message
      }

    default:
      return state
  }
}

/** Rows currently held for display, across every Result Set. */
export function retainedRowCount(state: QueryRunState): number {
  return state.resultSets.reduce((total, set) => total + set.rows.length, 0)
}
