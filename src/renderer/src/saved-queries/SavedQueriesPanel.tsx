import { useEffect, useState } from 'react'
import type { SavedQuery } from '@shared/types/saved-query'
import { Collapsible } from '../Collapsible'

interface Props {
  /** Bumped by the app whenever a query is saved from the editor toolbar, so
   * the list reloads without the panel owning the save action. */
  refreshToken: number
  onOpen: (savedQuery: SavedQuery) => void
}

/**
 * Saved Queries (user story 51): a user-named, reusable library of query
 * text, distinct from the automatic, read-only Query History (HistoryPanel).
 * It lives in the sidebar beside Connections and History — all three are
 * things you pick from — while *saving* happens in the editor toolbar,
 * next to the text being saved (QueryWorkspace owns the active tab).
 * "Open" seeds a *new* tab with the saved text rather than overwriting the
 * active tab's editor in place — QueryEditor only reads `initialValue` once
 * at mount (user story 22's remount-per-tab design).
 */
export function SavedQueriesPanel({ refreshToken, onOpen }: Props): React.JSX.Element {
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      setSavedQueries(await window.api.savedQueries.list())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
  }, [refreshToken])

  async function handleDelete(savedQuery: SavedQuery): Promise<void> {
    if (!window.confirm(`Delete saved query “${savedQuery.name}”?`)) return
    try {
      await window.api.savedQueries.delete(savedQuery.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Collapsible id="saved-queries" title="Saved queries" count={savedQueries.length}>
      {error && <p role="alert">{error}</p>}
      {savedQueries.length === 0 ? (
        <p className="empty">Use “Save query…” above the editor to keep a query for later.</p>
      ) : (
        <ul className="saved-list">
          {savedQueries.map((savedQuery) => (
            <li key={savedQuery.id} className="saved-card">
              <div className="saved-card__head">
                <strong className="saved-card__name" title={savedQuery.name}>
                  {savedQuery.name}
                </strong>
                {savedQuery.databaseKind && <span className="chip">{savedQuery.databaseKind}</span>}
              </div>
              <pre className="code-snippet">{savedQuery.queryText}</pre>
              <div className="saved-card__actions">
                <button type="button" onClick={() => onOpen(savedQuery)}>
                  Open in new tab
                </button>
                <button
                  type="button"
                  className="btn--ghost btn--danger"
                  onClick={() => void handleDelete(savedQuery)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Collapsible>
  )
}
