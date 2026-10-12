import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseMetadata, DatabaseMetadataObject } from '@shared/types/database-provider'
import type { Theme } from '@shared/types/preferences'
import { NewConnectionForm } from './NewConnectionForm'
import { QueryWorkspace, type QueryWorkspaceHandle } from './query-tabs/QueryWorkspace'
import { HistoryPanel } from './history/HistoryPanel'
import { SavedQueriesPanel } from './saved-queries/SavedQueriesPanel'
import { Collapsible, OPEN_SECTION_EVENT } from './Collapsible'
import { OverflowMenu } from './OverflowMenu'
import { SidebarResizer, useSidebarWidth } from './SidebarResizer'
import { SidebarRail } from './SidebarRail'
import { RAIL_WIDTH, useSidebarCollapsed } from './sidebar-collapsed'
import { ENVIRONMENT_SHORT } from './connection-environment'
import { markConnectionsLost, type ConnectionStatus } from './connection-status'
import type { SavedQuery } from '@shared/types/saved-query'
import { CosmosIcon, DatabaseIcon, MoonIcon, PlusIcon, SidebarIcon, SunIcon } from './icons'
import logoOnDark from './assets/brand/queryforge-logo-dark.png'
import logoOnLight from './assets/brand/queryforge-logo-light.png'


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
  const rail = useSidebarCollapsed()
  const [savedQueriesVersion, setSavedQueriesVersion] = useState(0)

  // Story 63: the utilityProcess died, so every live connection is gone.
  // Messages are derived from a ref, not inside a state updater, which must
  // stay pure (StrictMode double-invokes updaters).
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  useEffect(
    () =>
      window.api.queryExecution.onServiceExited(() => {
        const lostIds = Object.keys(statusesRef.current).filter(
          (id) => statusesRef.current[id] === 'connected'
        )
        setStatuses((prev) => markConnectionsLost(prev))
        setTestMessages((prev) => ({
          ...prev,
          ...Object.fromEntries(
            lostIds.map((id) => [
              id,
              'The query execution service stopped unexpectedly. Reconnect to continue.'
            ])
          )
        }))
        setMetadataByConnection({})
      }),
    []
  )

  useEffect(() => {
    window.api.preferences
      .get()
      .then((prefs) => {
        setTheme(prefs.theme)
        document.documentElement.dataset.theme = prefs.theme
      })
      .catch(() => {})
  }, [])

  // Cmd/Ctrl+B toggles the sidebar, like most editors.
  const { toggle: toggleSidebar } = rail
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  /** Rail click: expand, then bring the card into view and focus it. */
  function revealConnection(id: string): void {
    rail.setCollapsed(false)
    window.setTimeout(() => {
      const card = document.getElementById(`conn-${id}`)
      card?.scrollIntoView({ block: 'nearest' })
      card?.focus()
    }, 0)
  }

  function openSection(id: 'saved-queries' | 'history'): void {
    rail.setCollapsed(false)
    window.dispatchEvent(new CustomEvent(OPEN_SECTION_EVENT, { detail: id }))
    window.setTimeout(
      () => document.getElementById(`section-${id}`)?.scrollIntoView({ block: 'nearest' }),
      0
    )
  }

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
    const hasMetadata = metadataByConnection[connection.id] !== undefined
    const kindLabel = isCosmos ? 'Azure Cosmos DB' : 'Azure SQL Database'
    const needsAttention = status === 'connecting' || status === 'error'
    return (
      <li
        key={connection.id}
        id={`conn-${connection.id}`}
        tabIndex={-1}
        className="conn"
        data-status={status}
        data-env={connection.environment}
      >
        <div className="conn__head">
          <span
            className="conn__kind"
            title={`${kindLabel}${connection.hasSecret ? ', credentials saved' : ''}`}
          >
            {isCosmos ? <CosmosIcon /> : <DatabaseIcon />}
            <span className="status-dot conn__dot" data-status={status} aria-hidden="true" />
          </span>
          <strong className="conn__name" title={connection.name}>
            {connection.name}
          </strong>
          {status === 'connected' ? (
            <button
              type="button"
              className="btn--ghost conn__primary"
              onClick={() => handleDisconnect(connection.id)}
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              className="btn--ghost conn__primary conn__connect"
              disabled={status === 'connecting'}
              onClick={() => handleConnect(connection.id)}
            >
              Connect
            </button>
          )}
          <OverflowMenu
            label={`More actions for ${connection.name}`}
            items={[
              {
                label: hasMetadata ? 'Refresh metadata' : 'Browse metadata',
                disabled: status !== 'connected',
                onSelect: () => void handleBrowseMetadata(connection.id)
              },
              {
                label: 'Test connection',
                onSelect: () => void handleTest(connection.id)
              },
              { label: 'Edit', onSelect: () => setEditingId(connection.id) },
              {
                label: 'Delete',
                danger: true,
                onSelect: () => {
                  if (window.confirm(`Delete connection “${connection.name}”?`)) {
                    void handleDelete(connection.id)
                  }
                }
              }
            ]}
          />
        </div>
        {/* The dot and green border already say "connected"; the word is only
            shown when something needs attention, and stays readable to screen
            readers either way. */}
        <span className="visually-hidden">{needsAttention ? '' : status}</span>
        {(connection.environment || connection.readOnly || needsAttention) && (
          <div className="conn__badges">
            {connection.environment && (
              <span className="chip chip--env" data-env={connection.environment}>
                {ENVIRONMENT_SHORT[connection.environment]}
              </span>
            )}
            {connection.readOnly && <span className="chip">read-only</span>}
            {needsAttention && (
              <span className="conn__status-text" data-status={status}>
                {status}
              </span>
            )}
          </div>
        )}
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
        <div className="topbar__lead">
          <button
            type="button"
            className="btn--ghost sidebar-toggle"
            aria-label={rail.collapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-expanded={!rail.collapsed}
            aria-controls="sidebar"
            title={`${rail.collapsed ? 'Show' : 'Hide'} sidebar (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}B)`}
            onClick={rail.toggle}
          >
            <SidebarIcon size={18} />
          </button>
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
        </div>
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
        style={
          {
            '--sidebar-w': `${rail.collapsed ? RAIL_WIDTH : sidebar.width}px`
          } as React.CSSProperties
        }
      >
        <aside
          id="sidebar"
          className="sidebar"
          data-collapsed={rail.collapsed || undefined}
          aria-label="Connections, saved queries and history"
        >
          {error && (
            <p role="alert" className="sidebar__error">
              {error}
            </p>
          )}
          {rail.collapsed && (
            <SidebarRail
              connections={connections}
              statuses={statuses}
              onRevealConnection={revealConnection}
              onOpenSection={openSection}
              onNewConnection={() => {
                setShowNewForm(true)
                rail.setCollapsed(false)
              }}
            />
          )}
          {/* Stays mounted while collapsed (just hidden) so a half-filled form
              or a history search survives. */}
          <div className="sidebar__content" hidden={rail.collapsed}>

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

              {connections.length === 0
                ? !showNewForm && (
                    <p className="empty">
                      No saved connections yet. Add an Azure SQL Database or Cosmos DB account to
                      start querying.
                    </p>
                  )
                : groupKeys.map((key) => (
                    <div key={key || '(ungrouped)'} className="conn-group">
                      {key && <h3>{key}</h3>}
                      <ul className="conn-list">{groups.get(key)!.map(renderConnection)}</ul>
                    </div>
                  ))}
            </Collapsible>

            <SavedQueriesPanel refreshToken={savedQueriesVersion} onOpen={handleOpenSavedQuery} />

            <HistoryPanel />
          </div>
        </aside>
        {!rail.collapsed && <SidebarResizer {...sidebar} />}

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
  const [filter, setFilter] = useState('')
  const term = filter.trim().toLowerCase()
  const objects = term ? filterObjects(metadata.objects, term) : metadata.objects
  return (
    <div className="tree-panel">
      {countObjects(metadata.objects) >= TREE_FILTER_THRESHOLD && (
        <input
          type="search"
          className="tree-panel__filter"
          placeholder="Filter by name…"
          aria-label="Filter metadata by name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {term && objects.length === 0 ? (
        <p className="empty">Nothing named “{filter.trim()}”.</p>
      ) : (
        <TreeList
          objects={objects}
          onOpen={onOpen}
          parentSchema={undefined}
          forceOpen={term.length > 0}
          // A lone top-level database is the only thing to open — do it for them.
          openByDefault={objects.length === 1}
        />
      )}
    </div>
  )
}

/** Below this many nodes a filter box is just chrome. */
const TREE_FILTER_THRESHOLD = 10

/** Kinds that are a flat set of named things, where A–Z is the right order.
 * Columns and indexes keep the provider's order — ordinal position matters. */
const SORTABLE_KINDS = new Set(['database', 'schema', 'container', 'table', 'view'])
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sortObjects(objects: DatabaseMetadataObject[]): DatabaseMetadataObject[] {
  return objects.every((object) => SORTABLE_KINDS.has(object.kind))
    ? [...objects].sort((a, b) => nameCollator.compare(a.name, b.name))
    : objects
}

function countObjects(objects: DatabaseMetadataObject[]): number {
  return objects.reduce((sum, object) => sum + 1 + countObjects(object.children ?? []), 0)
}

/** Keeps nodes whose name matches, plus the ancestors needed to reach them. A
 * parent that matches by itself keeps its whole subtree. */
function filterObjects(objects: DatabaseMetadataObject[], term: string): DatabaseMetadataObject[] {
  return objects.flatMap((object) => {
    const children = object.children ?? []
    const keptChildren = filterObjects(children, term)
    if (keptChildren.length > 0) return [{ ...object, children: keptChildren }]
    return object.name.toLowerCase().includes(term) ? [object] : []
  })
}

function TreeList({
  objects: unsortedObjects,
  onOpen,
  parentSchema,
  forceOpen,
  openByDefault
}: {
  objects: DatabaseMetadataObject[]
  onOpen: (object: DatabaseMetadataObject) => void
  parentSchema: string | undefined
  /** Expand every branch (while a filter is active, so matches are visible). */
  forceOpen?: boolean
  openByDefault?: boolean
}): React.JSX.Element {
  const objects = sortObjects(unsortedObjects)
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
              <details className="tree__branch" open={forceOpen || openByDefault || undefined}>
                <summary onDoubleClick={() => onOpen(withSchema)}>{label}</summary>
                <TreeList
                  objects={object.children!}
                  onOpen={onOpen}
                  parentSchema={object.kind === 'schema' ? object.name : parentSchema}
                  forceOpen={forceOpen}
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
