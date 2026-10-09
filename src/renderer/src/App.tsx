import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseMetadata, DatabaseMetadataObject } from '@shared/types/database-provider'
import type { Theme } from '@shared/types/preferences'
import { NewConnectionForm } from './NewConnectionForm'
import { QueryWorkspace, type QueryWorkspaceHandle } from './query-tabs/QueryWorkspace'
import { HistoryPanel } from './history/HistoryPanel'
import { SavedQueriesPanel } from './saved-queries/SavedQueriesPanel'
import { Collapsible } from './Collapsible'
import { SidebarResizer, useSidebarWidth } from './SidebarResizer'
import type { SavedQuery } from '@shared/types/saved-query'
import { CosmosIcon, DatabaseIcon, LockIcon, MoonIcon, PlusIcon, SunIcon } from './icons'
import logoOnDark from './assets/brand/queryforge-logo-dark.png'
import logoOnLight from './assets/brand/queryforge-logo-light.png'

/** Connection status (user story 10) — tracked client-side; the Query
 * Execution Service itself has no separate "status" concept, only whether
 * a profile id currently has a live provider instance. */
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export function App(): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionProfile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [testMessages, setTestMessages] = useState<Record<string, string>>({})
  const [metadataByConnection, setMetadataByConnection] = useState<
    Record<string, DatabaseMetadata>
  >({})
  const [theme, setTheme] = useState<Theme>('dark')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showNewForm, setShowNewForm] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const workspaceRef = useRef<QueryWorkspaceHandle>(null)
  const sidebar = useSidebarWidth()
  const [savedQueriesVersion, setSavedQueriesVersion] = useState(0)

  useEffect(() => {
    window.api.preferences
      .get()
      .then((prefs) => {
        setTheme(prefs.theme)
        document.documentElement.dataset.theme = prefs.theme
      })
      .catch(() => {})
  }, [])

  async function handleToggleTheme(): Promise<void> {
    const previous = theme
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      await window.api.preferences.update({ theme: next })
    } catch (err) {
      // Revert the optimistic UI/DOM update — otherwise the app could show
      // (and keep rendering in) a theme that was never actually persisted,
      // same failure mode HistoryPanel's persistQueryText toggle guards
      // against.
      setTheme(previous)
      document.documentElement.dataset.theme = previous
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function refresh(): Promise<void> {
    try {
      const list = await window.api.connections.list()
      setConnections(list)
      // A first-run user has nothing to connect to yet, so open the form for
      // them once, rather than making them hunt for the "+" button.
      if (!loaded) setShowNewForm(list.length === 0)
      setLoaded(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleDelete(id: string): Promise<void> {
    await window.api.connections.delete(id)
    await refresh()
  }

  async function handleTest(id: string): Promise<void> {
    setTestMessages((prev) => ({ ...prev, [id]: 'Testing…' }))
    try {
      const result = await window.api.queryExecution.test({ profileId: id })
      setTestMessages((prev) => ({
        ...prev,
        [id]: result.success ? 'Connection OK' : `Failed: ${result.message ?? 'unknown error'}`
      }))
    } catch (err) {
      setTestMessages((prev) => ({
        ...prev,
        [id]: `Failed: ${err instanceof Error ? err.message : String(err)}`
      }))
    }
  }

  async function handleConnect(id: string): Promise<void> {
    setStatuses((prev) => ({ ...prev, [id]: 'connecting' }))
    try {
      await window.api.queryExecution.connect(id)
      setStatuses((prev) => ({ ...prev, [id]: 'connected' }))
      // lastConnectedAt changed on the main side (recent connections, story 11).
      await refresh()
    } catch (err) {
      setStatuses((prev) => ({ ...prev, [id]: 'error' }))
      setTestMessages((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : String(err)
      }))
    }
  }

  async function handleDisconnect(id: string): Promise<void> {
    await window.api.queryExecution.disconnect(id)
    setStatuses((prev) => ({ ...prev, [id]: 'disconnected' }))
    setMetadataByConnection((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function handleBrowseMetadata(id: string): Promise<void> {
    try {
      const metadata = await window.api.queryExecution.getMetadata(id)
      setMetadataByConnection((prev) => ({ ...prev, [id]: metadata }))
    } catch (err) {
      setTestMessages((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : String(err)
      }))
    }
  }

  /** Double-click in the Object Explorer (user story 17): open a new query
   * tab prefilled with a sample-records query for the object. */
  function handleOpenObject(connection: ConnectionProfile, object: DatabaseMetadataObject): void {
    if (connection.config.kind === 'cosmos-db') {
      if (object.kind !== 'container') return
      workspaceRef.current?.openQuery({
        title: object.name,
        connectionId: connection.id,
        queryText: 'SELECT TOP 100 * FROM c',
        options: { database: object.database, container: object.name }
      })
      return
    }
    if (object.kind !== 'table' && object.kind !== 'view') return
    workspaceRef.current?.openQuery({
      title: object.name,
      connectionId: connection.id,
      queryText: `SELECT TOP 100 * FROM ${object.schema ? `[${object.schema}].` : ''}[${object.name}]`
    })
  }

  /** "Open in new tab" for a Saved Query — its connection association is only
   * honored if that profile still exists; a deleted Connection Profile (user
   * story 5) must not leave the new tab pointing at a dangling id. */
  function handleOpenSavedQuery(savedQuery: SavedQuery): void {
    const connectionId = connections.some((c) => c.id === savedQuery.profileId)
      ? savedQuery.profileId
      : undefined
    workspaceRef.current?.openQuery({
      title: savedQuery.name,
      queryText: savedQuery.queryText,
      connectionId
    })
  }

  const recents = [...connections]
    .filter((c) => c.lastConnectedAt)
    .sort((a, b) => (b.lastConnectedAt ?? '').localeCompare(a.lastConnectedAt ?? ''))
    .slice(0, 5)

  const groups = new Map<string, ConnectionProfile[]>()
  for (const connection of connections) {
    const key = connection.groupName ?? ''
    groups.set(key, [...(groups.get(key) ?? []), connection])
  }
  const groupKeys = [...groups.keys()].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)
  )

  function renderConnection(connection: ConnectionProfile): React.JSX.Element {
    const status = statuses[connection.id] ?? 'disconnected'
    if (editingId === connection.id) {
      return (
        <li key={connection.id} className="sidebar__form">
          <NewConnectionForm
            editing={connection}
            onCreated={() => {
              setEditingId(null)
              // The Query Execution Service keeps the profile as it was at
              // connect() time (including readOnly and credentials), so an
              // edited, still-connected profile must reconnect to take effect.
              if (status === 'connected') void handleDisconnect(connection.id)
              void refresh()
            }}
            onCancel={() => setEditingId(null)}
          />
        </li>
      )
    }
    const message = testMessages[connection.id]
    const isCosmos = connection.config.kind === 'cosmos-db'
    return (
      <li key={connection.id} className="conn" data-status={status}>
        <div className="conn__head">
          <span className="conn__kind" title={isCosmos ? 'Azure Cosmos DB' : 'Azure SQL Database'}>
            {isCosmos ? <CosmosIcon /> : <DatabaseIcon />}
          </span>
          <strong className="conn__name">{connection.name}</strong>
          <span className="conn__status">
            <span className="conn__dot" aria-hidden="true" />
            {status}
          </span>
        </div>
        {(connection.readOnly || connection.hasSecret) && (
          <div className="conn__badges">
            {connection.readOnly && <span className="chip">read-only</span>}
            {connection.hasSecret && (
              <span className="chip">
                <LockIcon size={11} /> credentials saved
              </span>
            )}
          </div>
        )}
        <div className="conn__actions">
          {status === 'connected' ? (
            <button
              type="button"
              className="btn--ghost"
              onClick={() => handleDisconnect(connection.id)}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              className="btn--ghost conn__connect"
              disabled={status === 'connecting'}
              onClick={() => handleConnect(connection.id)}
            >
              Connect
            </button>
          )}
          <button type="button" className="btn--ghost" onClick={() => handleTest(connection.id)}>
            Test
          </button>
          <button
            type="button"
            className="btn--ghost"
            disabled={status !== 'connected'}
            onClick={() => handleBrowseMetadata(connection.id)}
          >
            {metadataByConnection[connection.id] ? 'Refresh metadata' : 'Browse metadata'}
          </button>
          <button type="button" className="btn--ghost" onClick={() => setEditingId(connection.id)}>
            Edit
          </button>
          <button
            type="button"
            className="btn--ghost btn--danger"
            onClick={() => handleDelete(connection.id)}
          >
            Delete
          </button>
        </div>
        {message && <p className="conn__message">{message}</p>}
        {metadataByConnection[connection.id] && (
          <MetadataTree
            metadata={metadataByConnection[connection.id]}
            onOpen={(object) => handleOpenObject(connection, object)}
          />
        )}
      </li>
    )
  }

  const connectedCount = Object.values(statuses).filter((value) => value === 'connected').length

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar__brand">
          <img
            className="topbar__logo topbar__logo--on-dark"
            src={logoOnDark}
            alt="QueryForge"
            draggable={false}
          />
          <img
            className="topbar__logo topbar__logo--on-light"
            src={logoOnLight}
            alt="QueryForge"
            draggable={false}
          />
        </h1>
        <div className="topbar__tools">
          <span className="topbar__summary">
            {connectedCount > 0
              ? `${connectedCount} connected`
              : connections.length > 0
                ? 'Not connected'
                : ''}
          </span>
          <button
            type="button"
            className="theme-toggle"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => void handleToggleTheme()}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <div
        className="app__body"
        style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
      >
        <aside className="sidebar" aria-label="Connections, saved queries and history">
          {error && <p role="alert">{error}</p>}

          <Collapsible
            id="connections"
            title="Connections"
            actions={
              <button
                type="button"
                className="btn--ghost section-head__action"
                aria-expanded={showNewForm}
                onClick={() => setShowNewForm((open) => !open)}
              >
                <PlusIcon size={14} /> New connection
              </button>
            }
          >

            {showNewForm && (
              <div className="sidebar__form">
                <NewConnectionForm
                  onCreated={() => {
                    setShowNewForm(false)
                    void refresh()
                  }}
                />
              </div>
            )}

            {recents.length > 0 && (
              <div className="recents">
                <span className="recents__label">Recent</span>
                {recents.map((connection) => (
                  <button
                    key={connection.id}
                    type="button"
                    className="chip chip--button"
                    disabled={(statuses[connection.id] ?? 'disconnected') !== 'disconnected'}
                    onClick={() => void handleConnect(connection.id)}
                  >
                    {connection.name}
                  </button>
                ))}
              </div>
            )}

            {connections.length === 0 ? (
              !showNewForm && (
                <p className="empty">
                  No saved connections yet. Add an Azure SQL Database or Cosmos DB account to start
                  querying.
                </p>
              )
            ) : (
              groupKeys.map((key) => (
                <div key={key || '(ungrouped)'} className="conn-group">
                  {key && <h3>{key}</h3>}
                  <ul className="conn-list">{groups.get(key)!.map(renderConnection)}</ul>
                </div>
              ))
            )}
          </Collapsible>

          <SavedQueriesPanel refreshToken={savedQueriesVersion} onOpen={handleOpenSavedQuery} />

          <HistoryPanel />
        </aside>
        <SidebarResizer {...sidebar} />

        <main className="workspace">
          <QueryWorkspace
            ref={workspaceRef}
            connections={connections}
            onQuerySaved={() => setSavedQueriesVersion((v) => v + 1)}
          />
        </main>
      </div>
    </div>
  )
}

/**
 * Object Explorer tree (user stories 14-17): nested, collapsible via native
 * <details>, showing column types/primary keys/indexes (`detail`) and
 * partition keys. Double-clicking a table/view/container opens a sample
 * query for it.
 */
function MetadataTree({
  metadata,
  onOpen
}: {
  metadata: DatabaseMetadata
  onOpen: (object: DatabaseMetadataObject) => void
}): React.JSX.Element {
  return <TreeList objects={metadata.objects} onOpen={onOpen} parentSchema={undefined} />
}

function TreeList({
  objects,
  onOpen,
  parentSchema
}: {
  objects: DatabaseMetadataObject[]
  onOpen: (object: DatabaseMetadataObject) => void
  parentSchema: string | undefined
}): React.JSX.Element {
  // Twenty rows that all say "container" is noise: show the kind only where
  // siblings differ (schema next to table, say); it stays in the tooltip.
  const mixedKinds = objects.some((object) => object.kind !== objects[0]?.kind)
  return (
    <ul className="tree">
      {objects.map((object, index) => {
        const withSchema = parentSchema ? { ...object, schema: parentSchema } : object
        const label = (
          <>
            <span className="tree__name" title={`${object.name} (${object.kind})`}>
              {object.name}
            </span>
            {mixedKinds && <span className="tree__kind">{object.kind}</span>}
            {object.detail && <span className="tree__detail">{object.detail}</span>}
          </>
        )
        const hasChildren = object.children && object.children.length > 0
        return (
          <li key={`${object.kind}-${object.name}-${index}`}>
            {hasChildren ? (
              <details className="tree__branch">
                <summary onDoubleClick={() => onOpen(withSchema)}>{label}</summary>
                <TreeList
                  objects={object.children!}
                  onOpen={onOpen}
                  parentSchema={object.kind === 'schema' ? object.name : parentSchema}
                />
              </details>
            ) : (
              <span className="tree__leaf" onDoubleClick={() => onOpen(withSchema)}>
                {label}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
