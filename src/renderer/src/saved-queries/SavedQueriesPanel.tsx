import { useEffect, useState } from 'react'
import type { SavedQuery } from '@shared/types/saved-query'

interface Props {
  /** Whether the active tab currently has query text worth saving — disables
   * "Save current query" when there's nothing to save rather than letting it
   * silently create an empty Saved Query. */
  canSaveCurrent: boolean
  onSaveCurrent: (name: string) => Promise<void>
  onOpen: (savedQuery: SavedQuery) => void
}

/**
 * Saved Queries (user story 51): a user-named, reusable library of query
 * text, distinct from the automatic, read-only Query History (HistoryPanel).
 * "Save current query" captures the active tab's text via `onSaveCurrent`
 * (owned by QueryWorkspace, since only it knows which tab is active);
 * "Open" seeds a *new* tab with the saved text via `onOpen` rather than
 * overwriting the active tab's editor in place — QueryEditor only reads
 * `initialValue` once at mount (user story 22's remount-per-tab design), so
 * a new tab is the only way to load saved text without fighting that.
 */
export function SavedQueriesPanel({ canSaveCurrent, onSaveCurrent, onOpen }: Props): React.JSX.Element {
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
  }, [])

  async function handleSave(): Promise<void> {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSaveCurrent(name.trim())
      setName('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await window.api.savedQueries.delete(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="saved-queries-panel">
      <h2>Saved Queries</h2>
      {error && <p role="alert">{error}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void handleSave()
        }}
      >
        <input
          type="text"
          placeholder="Name this query…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={!canSaveCurrent || !name.trim() || saving}>
          Save current query
        </button>
      </form>

      {savedQueries.length === 0 ? (
        <p>No saved queries yet.</p>
      ) : (
        <ul>
          {savedQueries.map((savedQuery) => (
            <li key={savedQuery.id}>
              <strong>{savedQuery.name}</strong>
              {savedQuery.databaseKind ? ` — ${savedQuery.databaseKind}` : ''}
              <pre>{savedQuery.queryText}</pre>
              <button type="button" onClick={() => onOpen(savedQuery)}>
                Open in new tab
              </button>
              <button type="button" onClick={() => void handleDelete(savedQuery.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
