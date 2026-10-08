/**
 * One tab's export-in-progress state (user story 48: destination, progress,
 * cancel). Deliberately separate from `QueryRunState` (query-run-
 * reducer.ts) — a query run and an export are independent operations that
 * can overlap in time (e.g. exporting the previous run's loaded rows while
 * a new query is already executing in the same tab).
 *
 * `running`'s `kind` distinguishes the two export actions at the state
 * level, not just the UI label: "loaded" is a single bounded `invoke` with
 * no real progress feed and nothing to cancel (export-ipc.ts's doc — the
 * source is already a capped, in-memory array, so the call is fast and
 * finite by construction); "all" streams real per-chunk progress and is
 * cancellable. A single `rowsWritten` field shared by both kinds would
 * either have to fake a progress number for "loaded" or offer a Cancel
 * button that silently does nothing — both are real bugs this shape rules
 * out at the type level.
 */
export type ExportState =
  | { status: 'idle' }
  | { status: 'running'; kind: 'loaded' }
  | { status: 'running'; kind: 'all'; rowsWritten: number | undefined }
  | { status: 'done' }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }

export const initialExportState: ExportState = { status: 'idle' }
