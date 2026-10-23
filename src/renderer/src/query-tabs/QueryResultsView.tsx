import { useEffect, useMemo, useState } from 'react'
import { computeColumnUnion } from '@shared/column-union'
import {
  EXTRACTORS,
  getExtractor,
  type ExtractorId,
  type ExtractorOptions
} from '@shared/extractors/extract'
import { CellInspector } from '../results/CellInspector'
import { planCopy, type CopyPlan } from '../results/copy-plan'
import type { ExportState } from '../results/export-state'
import type { ExtractorSettings } from '../results/extractor-settings'
import { ResultsGrid, type GridCopy } from '../results/ResultsGrid'
import { ResultsJsonView } from '../results/ResultsJsonView'
import brandMark from '../assets/brand/queryforge-icon-transparent-1024.png'
import { retainedRowCount, type QueryRunState } from './query-run-reducer'

type ViewMode = 'table' | 'json'

const TOAST_MS = 2500

/** What "Export loaded…" writes: these rows, in these columns, through this
 * Extractor (the Active one unless given). */
export interface ExportLoadedRequest {
  rows: unknown[]
  columns: string[]
  resultSet: number
  extractorId?: ExtractorId
}

/**
 * Results display (user stories 38-44): status/duration/RU bar, then either
 * the virtualized TanStack grid or the JSON view of the selected Result Set's
 * rows — switchable without re-executing the query (user story 43). A
 * multi-statement script (user story 61) gets a tab per Result Set; a
 * single-result run looks exactly as it always did.
 *
 * One strip holds the Active Extractor dropdown, the Include header toggle,
 * and (for SQL Extractors) the Table field; the selected Result Set's
 * Copy all / Export loaded… / Export all matching… all use it. Copies
 * happen here (clipboard, toast, size guard); export actions are wired by
 * the parent (QueryWorkspace), which also owns the Export Service IPC
 * calls — this component only renders the buttons and forwards clicks,
 * keeping it ignorant of IPC/export-progress plumbing.
 */
export function QueryResultsView({
  run,
  exportState,
  extractorSettings,
  onExtractorSettingsChange,
  tableName,
  onTableNameChange,
  onExportLoaded,
  onExportAll,
  onCancelExport
}: {
  run: QueryRunState
  exportState: ExportState
  extractorSettings: ExtractorSettings
  onExtractorSettingsChange: (patch: Partial<ExtractorSettings>) => void
  /** The tab's Table field value for the SQL Extractors. */
  tableName: string
  onTableNameChange: (tableName: string) => void
  onExportLoaded: (request: ExportLoadedRequest) => void
  onExportAll: (resultSet: number) => void
  onCancelExport: () => void
}): React.JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [inspectedCell, setInspectedCell] = useState<unknown>(undefined)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // Bumped per inspected cell so the inspector's JSON tree starts fresh
  // (expanded, no Find query) rather than carrying over the last cell's.
  const [inspection, setInspection] = useState(0)
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
  const columns = useMemo(() => computeColumnUnion(currentRows), [currentRows])
  const streaming = run.status === 'running'
  const activeExtractor = getExtractor(extractorSettings.extractorId)
  const extractorOptions: ExtractorOptions = {
    includeHeader: extractorSettings.includeHeader,
    tableName
  }

  const [toast, setToast] = useState<{ message: string; id: number } | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])
  /** An oversized copy waiting on "copy anyway / export instead" (user story 11). */
  const [pendingCopy, setPendingCopy] = useState<{
    plan: CopyPlan
    rows: unknown[]
    extractorId: ExtractorId
  } | null>(null)

  function writeClipboard(plan: CopyPlan): void {
    navigator.clipboard.writeText(plan.text).then(
      () => setToast({ message: plan.message, id: Date.now() }),
      (err) => setToast({ message: `Copy failed: ${String(err)}`, id: Date.now() })
    )
  }

  function handleCopy(copy: GridCopy): void {
    if (copy.scope === 'cell') {
      writeClipboard(planCopy(copy))
      return
    }
    const extractorId = copy.extractorId ?? activeExtractor.id
    const plan = planCopy({
      scope: 'rows',
      rows: copy.rows,
      columns,
      extractorId,
      options: extractorOptions
    })
    if (plan.needsSizeConfirmation) setPendingCopy({ plan, rows: copy.rows, extractorId })
    else writeClipboard(plan)
  }
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

            <div className="extractor-strip" aria-label="Copy and export format">
              <label className="extractor-strip__field">
                <span>Format</span>
                <select
                  value={activeExtractor.id}
                  onChange={(e) =>
                    onExtractorSettingsChange({ extractorId: e.target.value as ExtractorId })
                  }
                >
                  {EXTRACTORS.map((extractor) => (
                    <option key={extractor.id} value={extractor.id}>
                      {extractor.label}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="extractor-strip__toggle"
                title={activeExtractor.hasHeader ? undefined : `${activeExtractor.label} has no header`}
              >
                <input
                  type="checkbox"
                  checked={extractorSettings.includeHeader}
                  disabled={!activeExtractor.hasHeader}
                  onChange={(e) => onExtractorSettingsChange({ includeHeader: e.target.checked })}
                />
                Include header
              </label>
              {activeExtractor.usesTableName && (
                <label className="extractor-strip__field">
                  <span>Table</span>
                  <input
                    type="text"
                    value={tableName}
                    spellCheck={false}
                    onChange={(e) => onTableNameChange(e.target.value)}
                  />
                </label>
              )}
            </div>

            {/* "Loaded" vs "all matching" is a deliberate, visible UI
             * distinction (user story 47), not two modes of the same
             * button — "all" re-executes the query in main under a new
             * Execution ID and is uncapped, unlike what's on screen.
             *
             * "Copy all" and "Export loaded" are disabled while the run is
             * still `'running'`: their source is `run.rows` at click time,
             * but a still-running query keeps appending to that same array
             * — copying or exporting mid-run would silently write fewer
             * rows than the grid ends up showing once the run finishes.
             * "Export all matching" stays file-only (never clipboard): it
             * re-runs the query, a second RU charge (user story 15). */}
            <span className="query-results__export-group">
              <button
                type="button"
                disabled={streaming}
                title={`Copies every loaded row of this result as ${activeExtractor.label}`}
                onClick={() => handleCopy({ scope: 'rows', rows: currentRows })}
              >
                Copy all
              </button>
              <button
                type="button"
                disabled={streaming}
                title={`Writes the rows already loaded in this view as ${activeExtractor.label}`}
                onClick={() => onExportLoaded({ rows: currentRows, columns, resultSet: setIndex })}
              >
                Export loaded…
              </button>
            </span>
            <span className="query-results__export-group query-results__export-group--all">
              <button
                type="button"
                title={
                  `Runs the query again and writes every matching row of the selected result as ${activeExtractor.label}. Cosmos DB charges request units for the second run.` +
                  (activeExtractor.buffersAllRows
                    ? ` ${activeExtractor.label} holds every row in memory before writing; JSON or JSON Lines stream instead.`
                    : '')
                }
                onClick={() => onExportAll(setIndex)}
              >
                Export all matching…
              </button>
              {activeExtractor.buffersAllRows && (
                <span className="query-results__export-label">holds all rows in memory</span>
              )}
            </span>
          </div>

          {pendingCopy && (
            <div className="query-results__copy-guard" role="alertdialog" aria-label="Large copy">
              <span>
                This copy is {(pendingCopy.plan.text.length / (1024 * 1024)).toFixed(1)} MB of text,
                which can freeze the app or your clipboard.
              </span>
              <button
                type="button"
                onClick={() => {
                  writeClipboard(pendingCopy.plan)
                  setPendingCopy(null)
                }}
              >
                Copy anyway
              </button>
              <button
                type="button"
                className="btn--primary"
                autoFocus
                onClick={() => {
                  onExportLoaded({
                    rows: pendingCopy.rows,
                    columns,
                    resultSet: setIndex,
                    extractorId: pendingCopy.extractorId
                  })
                  setPendingCopy(null)
                }}
              >
                Export to file instead
              </button>
              <button type="button" className="btn--ghost" onClick={() => setPendingCopy(null)}>
                Cancel
              </button>
            </div>
          )}

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
              columns={columns}
              streaming={streaming}
              onCopy={handleCopy}
              onExpandCell={(value) => {
                setInspectedCell(value)
                setInspection((n) => n + 1)
                setInspectorOpen(true)
              }}
            />
          ) : (
            <ResultsJsonView
              // Remount per run and per Result Set so collapse state doesn't
              // leak across results; rows streaming into the same run keep it.
              key={`${run.startedAt}:${setIndex}`}
              rows={currentRows}
              onSave={() =>
                onExportLoaded({ rows: currentRows, columns, resultSet: setIndex, extractorId: 'json' })
              } />
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

      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.message}
        </div>
      )}

      {inspectorOpen && (
        <CellInspector
          key={inspection}
          value={inspectedCell} onClose={() => setInspectorOpen(false)} />
      )}
    </div>
  )
}
