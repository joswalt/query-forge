import { useEffect, useRef, useState } from 'react'
import type { QueryHistoryEntry } from '@shared/types/query-history'

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
    <section className="history-panel">
      <h2>Query History</h2>
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
        <button
          type="button"
          onClick={() => {
            setSearchTerm('')
            void refresh('')
          }}
        >
          Reset search
        </button>
        <button type="button" onClick={() => void handleClearHistory()}>
          Clear history
        </button>
      </form>

      {entries.length === 0 ? (
        <p>{hasSearched ? 'No history entries match your search.' : 'No query history yet.'}</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.profileName}</strong> — {entry.status} — {entry.durationMs}ms
              {entry.rowCount !== undefined ? ` — ${entry.rowCount} rows` : ''}
              {' — '}
              <time dateTime={entry.executedAt}>{new Date(entry.executedAt).toLocaleString()}</time>
              {entry.errorMessage && <p role="alert">{entry.errorMessage}</p>}
              {entry.queryText && (
                <>
                  <pre>{entry.queryText}</pre>
                  <button type="button" onClick={() => void handleCopyQuery(entry)}>
                    {copiedId === entry.id ? 'Copied!' : 'Copy query'}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
