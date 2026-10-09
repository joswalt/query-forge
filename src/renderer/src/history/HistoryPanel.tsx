import { useEffect, useRef, useState } from 'react'
import type { QueryHistoryEntry } from '@shared/types/query-history'
import { Collapsible } from '../Collapsible'

/**
 * Query History (user stories 50, 52, 53) — a read-only list fed by
 * `window.api.history`, refreshed automatically whenever a query run
 * settles (`history:updated`, sent by `query-execution-ipc.ts`'s
 * `streamQuery`) rather than only on a manual action. The "persist query
 * text" checkbox is the UI for user story 53's explicit opt-in — off by
 * default, matching `defaultPreferences` (preferences.ts). "Clear history"
 * is its companion retention control — opting in and later opting back out
 * doesn't by itself delete text already persisted; this button does.
 */
export function HistoryPanel(): React.JSX.Element {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const [persistQueryText, setPersistQueryText] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Read by the `history:updated` subscription below, which must always act
  // on the *current* search filter without re-subscribing its IPC listener
  // on every keystroke (a plain closure over `searchTerm` captured only the
  // value from first render — see the bug this replaced).
  const searchTermRef = useRef(searchTerm)
  searchTermRef.current = searchTerm
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    return () => clearTimeout(copiedTimeoutRef.current)
  }, [])

  async function refresh(term: string): Promise<void> {
    try {
      const results = term.trim() ? await window.api.history.search(term) : await window.api.history.list()
      setEntries(results)
      setHasSearched(term.trim().length > 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh('')
    window.api.preferences
      .get()
      .then((prefs) => setPersistQueryText(prefs.queryHistory.persistQueryText))
      .catch(() => {})
    return window.api.history.onUpdated(() => void refresh(searchTermRef.current))
  }, [])

  async function handleTogglePersistQueryText(checked: boolean): Promise<void> {
    const previous = persistQueryText
    setPersistQueryText(checked)
    try {
      await window.api.preferences.update({ queryHistory: { persistQueryText: checked } })
    } catch (err) {
      // Revert the optimistic UI update — otherwise the checkbox could show
      // "opted in" while the stored preference silently stayed off (or vice
      // versa), which is exactly the kind of mismatch user story 53 cares
      // about getting right.
      setPersistQueryText(previous)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleClearHistory(): Promise<void> {
    if (!window.confirm('Delete all query history? This cannot be undone.')) return
    try {
      await window.api.history.clear()
      await refresh(searchTermRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Same `navigator.clipboard.writeText` mechanism `ResultsGrid.tsx` uses
   * for its own copy actions (data grid decision, ticket 05) — not a second
   * clipboard mechanism. Wrapped in try/catch here (unlike `ResultsGrid`'s
   * fire-and-forget calls) because this component already surfaces an
   * `error` banner a failed copy can usefully report into.
   */
  async function handleCopyQuery(entry: QueryHistoryEntry): Promise<void> {
    if (!entry.queryText) return
    try {
      await navigator.clipboard.writeText(entry.queryText)
      setCopiedId(entry.id)
      clearTimeout(copiedTimeoutRef.current)
      copiedTimeoutRef.current = setTimeout(
        () => setCopiedId((current) => (current === entry.id ? null : current)),
        1500
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Collapsible
      id="history"
      title="Query history"
      actions={
        <button
          type="button"
          className="btn--ghost btn--danger section-head__action"
          onClick={() => void handleClearHistory()}
        >
          Clear history
        </button>
      }
    >
      {error && <p role="alert">{error}</p>}

      <label>
        <input
          type="checkbox"
          checked={persistQueryText}
          onChange={(e) => void handleTogglePersistQueryText(e.target.checked)}
        />
        Persist query text in history
      </label>

      <form
        className="history-panel__search"
        onSubmit={(e) => {
          e.preventDefault()
          void refresh(searchTerm)
        }}
      >
        <input
          type="search"
          placeholder="Search history…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <button type="submit">Search</button>
        {hasSearched && (
          <button
            type="button"
            className="btn--ghost"
            onClick={() => {
              setSearchTerm('')
              void refresh('')
            }}
          >
            Reset search
          </button>
        )}
      </form>

      {entries.length === 0 ? (
        <p className="empty">
          {hasSearched
            ? 'No history entries match your search.'
            : 'Queries you run will show up here.'}
        </p>
      ) : (
        <ul className="history-list">
          {entries.map((entry) => (
            <li key={entry.id} className="history-entry" data-status={entry.status}>
              <div className="history-entry__head">
                <strong className="history-entry__name">{entry.profileName}</strong>
                <span className="status-pill" data-status={entry.status}>
                  {entry.status}
                </span>
              </div>
              <div className="history-entry__stats">
                <span>{entry.durationMs} ms</span>
                {entry.rowCount !== undefined && <span>{entry.rowCount} rows</span>}
                <time dateTime={entry.executedAt}>
                  {new Date(entry.executedAt).toLocaleString()}
                </time>
              </div>
              {entry.errorMessage && <p role="alert">{entry.errorMessage}</p>}
              {entry.queryText && (
                <>
                  <pre className="code-snippet">{entry.queryText}</pre>
                  <button
                    type="button"
                    className="btn--ghost history-entry__copy"
                    onClick={() => void handleCopyQuery(entry)}
                  >
                    {copiedId === entry.id ? 'Copied' : 'Copy query'}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Collapsible>
  )
}
