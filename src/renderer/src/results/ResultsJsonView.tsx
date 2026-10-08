import { JsonTree } from './JsonTree'

/**
 * Upper bound on rows actually rendered as an interactive JSON tree.
 * Unlike `ResultsGrid` (TanStack Virtual — only visible rows are mounted),
 * `JsonTree` is a plain recursive React tree with no virtualization: at
 * `MAX_DISPLAY_ROWS` (query-run-reducer.ts, up to 50,000), mounting one
 * `JsonTree` node per row would freeze the renderer (user story 28). This
 * caps *rendering* only — "Copy JSON"/"Save JSON" still act on every row
 * in `rows`, not just what's displayed (user story 42).
 */
const JSON_VIEW_RENDER_LIMIT = 500

/**
 * Pretty-printed, syntax-highlighted, collapsible JSON view of the same
 * rows the table view shows (user story 40) — a pure alternate rendering
 * of `rows`, switchable without re-executing the query (user story 43).
 * "Save" delegates to the caller (QueryWorkspace), which routes it through
 * the Export Service's `exportLoadedRows` with format `json` — the same
 * capped row set the table view and this view both already hold.
 */
export function ResultsJsonView({
  rows,
  onSave
}: {
  rows: unknown[]
  onSave: () => void
}): React.JSX.Element {
  const truncated = rows.length > JSON_VIEW_RENDER_LIMIT
  const displayRows = truncated ? rows.slice(0, JSON_VIEW_RENDER_LIMIT) : rows

  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2))
  }

  return (
    <div className="results-json-view">
      <div className="results-json-view__toolbar">
        <button type="button" onClick={handleCopy}>
          Copy JSON
        </button>
        <button type="button" onClick={onSave}>
          Save JSON…
        </button>
      </div>
      {truncated && (
        <p>
          Showing the first {JSON_VIEW_RENDER_LIMIT} of {rows.length} loaded rows as a JSON tree.
          &quot;Copy JSON&quot; and &quot;Save JSON…&quot; still act on all {rows.length} rows — use
          the table view to browse beyond this point, or export.
        </p>
      )}
      <JsonTree value={displayRows} />
    </div>
  )
}
