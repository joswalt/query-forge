import type { QueryRunState } from './query-run-reducer'

/**
 * Minimal, non-virtualized results display — proves query execution,
 * duration, RU, and error/cancellation reporting end-to-end (user stories
 * 26-30, 34-35) through a plain HTML table, mirroring Phase 2's
 * `MetadataTree` precedent (App.tsx). The real results grid (TanStack
 * Table/Virtual, clipboard copy, JSON view, resizable columns — user
 * stories 38-43) is later "results/export" phase work per spec.md's build
 * order, not this slice.
 */
export function QueryResultsView({ run }: { run: QueryRunState }): React.JSX.Element {
  const durationMs =
    run.startedAt !== undefined && run.finishedAt !== undefined
      ? run.finishedAt - run.startedAt
      : undefined
  const firstRow = run.rows[0]
  const columns = isRecord(firstRow) ? Object.keys(firstRow) : []
  const truncated = run.rows.length < run.rowCount

  return (
    <div className="query-results">
      <div className="query-results__status">
        <span>Status: {run.status}</span>
        {run.status !== 'idle' && (
          <span>
            Rows: {run.rowCount}
            {truncated ? ` (showing first ${run.rows.length})` : ''}
          </span>
        )}
        {durationMs !== undefined && <span>Duration: {durationMs}ms</span>}
        {run.ruTotal !== undefined && <span>RU: {run.ruTotal.toFixed(2)}</span>}
      </div>

      {run.status === 'error' && run.errorMessage && <p role="alert">{run.errorMessage}</p>}
      {run.status === 'cancelled' && <p>Query cancelled.</p>}

      {columns.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>#</th>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row, index) => (
              <tr key={index}>
                <td>{index + 1}</td>
                {columns.map((column) => (
                  <td key={column}>{formatCell(isRecord(row) ? row[column] : undefined)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        run.status === 'success' && <p>Query returned no rows.</p>
      )}
    </div>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** NULL-value display (user story 38): explicit "NULL", not a blank cell. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
