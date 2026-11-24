import { useEffect, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { SavedQuery } from '@shared/types/saved-query'
import { OverflowMenu } from '../OverflowMenu'
import { ConnectionTag } from '../library/ConnectionTag'
import { useCopiedFlag } from '../library/use-copied-flag'

interface Props {
  /** Bumped by the app whenever a query is saved from the editor toolbar, so
   * the list reloads without the panel owning the save action. */
  refreshToken: number
  connections: ConnectionProfile[]
  onOpen: (savedQuery: SavedQuery) => void
  /** Reports how many saved queries there are, for the library tab. */
  onCountChange: (count: number) => void
}

/**
 * Saved Queries (user story 51): a user-named, reusable library of query
 * text, distinct from the automatic Query History. It shares the sidebar's
 * library pane with History, while *saving* happens in the editor toolbar,
 * next to the text being saved (QueryWorkspace owns the active tab).
 * Clicking a row seeds a *new* tab with the saved text rather than
 * overwriting the active tab's editor in place — QueryEditor only reads
 * `initialValue` once at mount (user story 22's remount-per-tab design).
 * Each row shows the Connection Profile it opens against, with its
 * Environment, so a query bound to prod reads as prod before it's opened.
 */
export function SavedQueriesPanel({
  refreshToken,
  connections,
  onOpen,
  onCountChange
}: Props): React.JSX.Element {
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copiedId, markCopied] = useCopiedFlag()

  async function refresh(): Promise<void> {
    try {
      const list = await window.api.savedQueries.list()
      setSavedQueries(list)
      onCountChange(list.length)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function handleCopy(savedQuery: SavedQuery): Promise<void> {
    try {
      await navigator.clipboard.writeText(savedQuery.queryText)
      markCopied(savedQuery.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="library-panel">
      {error && <p role="alert">{error}</p>}
      <p className="visually-hidden" role="status">
        {copiedId ? 'Query copied' : ''}
      </p>
      {savedQueries.length === 0 ? (
        <p className="empty">
          Use “Save query…” above the editor to keep a query here. Click a saved query to open it
          in a new tab.
        </p>
      ) : (
        <ul className="lib-list">
          {savedQueries.map((savedQuery) => {
            const connection = savedQuery.profileId
              ? connections.find((c) => c.id === savedQuery.profileId)
              : undefined
            return (
              <li key={savedQuery.id} className="lib-row" data-env={connection?.environment}>
                <button
                  type="button"
                  className="lib-row__body lib-row__open"
                  title="Open in new tab"
                  onClick={() => onOpen(savedQuery)}
                >
                  <span className="lib-row__head">
                    <span className="lib-row__title">{savedQuery.name}</span>
                    {copiedId === savedQuery.id && <span className="lib-row__time">Copied</span>}
                  </span>
                  <ConnectionTag
                    connection={connection}
                    kind={savedQuery.databaseKind}
                    fallbackName={savedQuery.profileId && !connection ? 'Deleted connection' : undefined}
                  />
                  <code className="lib-row__query">{savedQuery.queryText}</code>
                </button>
                <OverflowMenu
                  label={`More actions for ${savedQuery.name}`}
                  items={[
                    { label: 'Open in new tab', onSelect: () => onOpen(savedQuery) },
                    { label: 'Copy query', onSelect: () => void handleCopy(savedQuery) },
                    { label: 'Delete', danger: true, onSelect: () => void handleDelete(savedQuery) }
                  ]}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
