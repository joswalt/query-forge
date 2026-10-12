import { useState } from 'react'
import type { ExportFormat } from '@shared/types/export'
import { CellInspector } from '../results/CellInspector'
import type { ExportState } from '../results/export-state'
import { ResultsGrid } from '../results/ResultsGrid'
import { ResultsJsonView } from '../results/ResultsJsonView'
import brandMark from '../assets/brand/queryforge-icon-transparent-1024.png'
import { retainedRowCount, type QueryRunState } from './query-run-reducer'

type ViewMode = 'table' | 'json'

/**
 * Results display (user stories 38-44): status/duration/RU bar, then either
 * the virtualized TanStack grid or the JSON view of the selected Result Set's
 * rows — switchable without re-executing the query (user story 43). A
 * multi-statement script (user story 61) gets a tab per Result Set; a
 * single-result run looks exactly as it always did. Export
 * actions are wired by the parent (QueryWorkspace), which also owns the
 * Export Service IPC calls — this component only renders the buttons and
 * forwards clicks, keeping it ignorant of IPC/export-progress plumbing.
 */
export function QueryResultsView({
  run,
  exportState,
  onExportLoaded,
  onExportAll,
  onCancelExport
}: {
  run: QueryRunState
  exportState: ExportState
  onExportLoaded: (format: ExportFormat, resultSet: number) => void
  onExportAll: (format: ExportFormat, resultSet: number) => void
  onCancelExport: () => void
}): React.JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [inspectedCell, setInspectedCell] = useState<unknown>(undefined)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // The selection belongs to one run: a re-run, or switching to another
  // tab's run, starts back on the first Result Set instead of inheriting it.
  const [selection, setSelection] = useState({ startedAt: run.startedAt, index: 0 })
  const selectedSet = selection.startedAt === run.startedAt ? selection.index : 0

  const durationMs =
    run.startedAt !== undefined && run.finishedAt !== undefined
      ? run.finishedAt - run.startedAt
      : undefined
  const multiSet = run.resultSets.length > 1
  // A new run can have fewer sets than the one before; clamp rather than
  // reset state in an effect.
  const setIndex = Math.min(selectedSet, Math.max(run.resultSets.length - 1, 0))
  const current = run.resultSets[setIndex]
  const currentRows = current?.rows ?? []
  const truncated = retainedRowCount(run) < run.rowCount
  const hasRows = multiSet
    ? run.resultSets.some((set) => set.rowCount > 0)
    : currentRows.length > 0

  return (
    <div className="query-results">
      {run.status !== 'idle' && (
        <div className="query-results__status" data-status={run.status}>
          <span className="status-pill" data-status={run.status}>
            {run.status}
          </span>
          <span className="stat">
            <span className="stat__label">Rows</span>
            <span className="stat__value">
              {run.rowCount}
              {run.stoppedAtRowLimit ? '+' : ''}
              {truncated ? ` (showing first ${retainedRowCount(run)})` : ''}
            </span>
          </span>
          {durationMs !== undefined && (
            <span className="stat">
              <span className="stat__label">Duration</span>
              <span className="stat__value">{durationMs} ms</span>
            </span>
          )}
          {run.ruTotal !== undefined && (
            <span className="stat">
              <span className="stat__label">RU</span>
              <span className="stat__value">{run.ruTotal.toFixed(2)}</span>
            </span>
          )}
        </div>
      )}

      {run.status === 'error' && run.errorMessage && <p role="alert">{run.errorMessage}</p>}
      {run.status === 'cancelled' && <p className="empty">Query cancelled.</p>}
      {run.stoppedAtRowLimit && run.status !== 'running' && (
        <p className="query-results__notice" role="status">
          Stopped after {run.rowCount.toLocaleString()} rows to save request units — more rows
          match. Raise the row limit and re-run, or use “Export all matching”.
        </p>
      )}

      {hasRows && (
        <>
          {multiSet && (
            <div className="segmented segmented--sets" role="tablist" aria-label="Result sets">
              {run.resultSets.map((set, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === setIndex}
                  onClick={() => setSelection({ startedAt: run.startedAt, index: i })}
                >
                  Result {i + 1} ({set.rowCount} {set.rowCount === 1 ? 'row' : 'rows'})
                </button>
              ))}
            </div>
          )}
          <div className="query-results__toolbar">
            <div className="segmented" role="tablist" aria-label="Result view">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'table'}
                onClick={() => setViewMode('table')}
              >
                Table
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'json'}
                onClick={() => setViewMode('json')}
              >
                JSON
              </button>
            </div>

            {/* "Loaded" vs "all matching" is a deliberate, visible UI
             * distinction (user story 47), not two modes of the same
             * button — "all" re-executes the query in main under a new
             * Execution ID and is uncapped, unlike what's on screen.
             *
             * "Export loaded" is disabled while the run is still
             * `'running'`: its source is `run.rows` at click time, but a
             * still-running query keeps appending to that same array —
             * exporting mid-run would silently write fewer rows than the
             * grid ends up showing once the run finishes. */}
            <span
              className="query-results__export-group"
              title="Writes the rows already loaded in this view"
            >
              <span className="query-results__export-label">Export loaded</span>
              <button
                type="button"
                disabled={run.status === 'running'}
                onClick={() => onExportLoaded('csv', setIndex)}
              >
                CSV
              </button>
              <button
                type="button"
                disabled={run.status === 'running'}
                onClick={() => onExportLoaded('json', setIndex)}
              >
                JSON
              </button>
            </span>
            <span
              className="query-results__export-group query-results__export-group--all"
              title="Runs the query again and writes every matching row of the selected result. Cosmos DB charges request units for the second run."
            >
              <span className="query-results__export-label">Export all matching</span>
              <button type="button" onClick={() => onExportAll('csv', setIndex)}>
                CSV
              </button>
              <button type="button" onClick={() => onExportAll('json', setIndex)}>
                JSON
              </button>
            </span>
          </div>

          {exportState.status !== 'idle' && (
            <div className="query-results__export-status">
              {exportState.status === 'running' && exportState.kind === 'loaded' && (
                <span>Exporting…</span>
              )}
              {exportState.status === 'running' && exportState.kind === 'all' && (
                <>
                  <span>
                    Exporting…
                    {exportState.rowsWritten !== undefined
                      ? ` ${exportState.rowsWritten} rows written`
                      : ''}
                  </span>
                  <button type="button" className="btn--ghost" onClick={onCancelExport}>
                    Cancel export
                  </button>
                </>
              )}
              {exportState.status === 'done' && <span>Export complete.</span>}
              {exportState.status === 'cancelled' && <span>Export cancelled.</span>}
              {exportState.status === 'error' && (
                <span role="alert">Export failed: {exportState.message}</span>
              )}
            </div>
          )}

          {viewMode === 'table' ? (
            <ResultsGrid
              rows={currentRows}
              onExpandCell={(value) => {
                setInspectedCell(value)
                setInspectorOpen(true)
              }}
            />
          ) : (
            <ResultsJsonView rows={currentRows} onSave={() => onExportLoaded('json', setIndex)} />
          )}
        </>
      )}

      {!hasRows && run.status === 'success' && (
        <p className="empty">The query ran but returned no rows.</p>
      )}

      {run.status === 'idle' && (
        <div className="results-empty">
          <img src={brandMark} alt="" width={84} height={84} draggable={false} />
          <p className="results-empty__title">Results appear here</p>
          <p className="empty">Pick a connection, write a query, and press Run.</p>
        </div>
      )}

      {inspectorOpen && (
        <CellInspector value={inspectedCell} onClose={() => setInspectorOpen(false)} />
      )}
    </div>
  )
}
