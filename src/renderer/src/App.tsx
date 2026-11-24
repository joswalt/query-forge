import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseMetadata, DatabaseMetadataObject } from '@shared/types/database-provider'
import type { Theme } from '@shared/types/preferences'
import { NewConnectionForm } from './NewConnectionForm'
import { QueryWorkspace, type QueryWorkspaceHandle } from './query-tabs/QueryWorkspace'
import { HistoryPanel } from './history/HistoryPanel'
import { SavedQueriesPanel } from './saved-queries/SavedQueriesPanel'
import { LibraryPane, useLibraryTab, type LibraryTab } from './library/LibraryPane'
import { SidebarSplitter, useSidebarSplit } from './library/sidebar-split'
import { ConnectionGroup, OPEN_GROUP_EVENT } from './ConnectionGroup'
import { OverflowMenu } from './OverflowMenu'
import { SidebarResizer, useSidebarWidth } from './SidebarResizer'
import { SidebarRail } from './SidebarRail'
import { RAIL_WIDTH, useSidebarCollapsed } from './sidebar-collapsed'
import { ENVIRONMENT_SHORT } from './connection-environment'
import { markConnectionsLost, type ConnectionStatus } from './connection-status'
import { formatLastUsed } from './last-used'
import type { SavedQuery } from '@shared/types/saved-query'
import type { QueryHistoryEntry } from '@shared/types/query-history'
import { CosmosIcon, DatabaseIcon, MoonIcon, OpenIcon, PlusIcon, SidebarIcon, SunIcon } from './icons'
import logoOnDark from './assets/brand/queryforge-logo-dark.png'
import logoOnLight from './assets/brand/queryforge-logo-light.png'

/** A line under a connection card: a test result, a connect failure, or a
 * lost session. `tone` sets its colour. */
interface ConnectionMessage {
  text: string
  tone: 'info' | 'ok' | 'error'
}

export function App(): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionProfile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [testMessages, setTestMessages] = useState<Record<string, ConnectionMessage>>({})
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
  const split = useSidebarSplit()
  const sidebarRef = useRef<HTMLElement>(null)
  const [libraryTab, setLibraryTab] = useLibraryTab()
  const [savedQueriesVersion, setSavedQueriesVersion] = useState(0)
  const [savedCount, setSavedCount] = useState(0)

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
              {
                text: 'The query execution service stopped unexpectedly. Reconnect to continue.',
                tone: 'error'
              } satisfies ConnectionMessage
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
    const groupName = connections.find((c) => c.id === id)?.groupName
    if (groupName) window.dispatchEvent(new CustomEvent(OPEN_GROUP_EVENT, { detail: groupName }))
    window.setTimeout(() => {
      const card = document.getElementById(`conn-${id}`)
      card?.scrollIntoView({ block: 'nearest' })
      card?.focus()
    }, 0)
  }

  /** Rail click: expand and show that library tab. */
  function openLibrary(tab: LibraryTab): void {
    rail.setCollapsed(false)
    setLibraryTab(tab)
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
    setTestMessages((prev) => ({ ...prev, [id]: { text: 'Testing…', tone: 'info' } }))
    try {
      const result = await window.api.queryExecution.test({ profileId: id })
      setTestMessages((prev) => ({
        ...prev,
        [id]: result.success
          ? { text: 'Connection OK', tone: 'ok' }
          : { text: `Failed: ${result.message ?? 'unknown error'}`, tone: 'error' }
      }))
    } catch (err) {
      setTestMessages((prev) => ({
        ...prev,
        [id]: { text: `Failed: ${err instanceof Error ? err.message : String(err)}`, tone: 'error' }
      }))
    }
  }

  async function handleConnect(id: string): Promise<void> {
    setStatuses((prev) => ({ ...prev, [id]: 'connecting' }))
    try {
      await window.api.queryExecution.connect(id)
      setStatuses((prev) => ({ ...prev, [id]: 'connected' }))
      // lastConnectedAt changed on the main side (the row's "last used", story 11).
      await refresh()
    } catch (err) {
      setStatuses((prev) => ({ ...prev, [id]: 'error' }))
      setTestMessages((prev) => ({
        ...prev,
        [id]: { text: err instanceof Error ? err.message : String(err), tone: 'error' }
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
        [id]: { text: err instanceof Error ? err.message : String(err), tone: 'error' }
      }))
    }
  }

  /** Object Explorer open (user story 17), by double-click or the row's open
   * button: a new query tab prefilled with a sample-records query. */
  function handleOpenObject(connection: ConnectionProfile, object: DatabaseMetadataObject): void {
    if (!canOpenObject(connection, object)) return
    if (connection.config.kind === 'cosmos-db') {
      workspaceRef.current?.openQuery({
        title: object.name,
        connectionId: connection.id,
        queryText: 'SELECT TOP 100 * FROM c',
        options: { database: object.database, container: object.name }
      })
      return
    }
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

  /** History row click: a new tab with the entry's text, on its connection
   * (if it still exists) and the Cosmos database/container it ran against. */
  function handleOpenHistoryEntry(entry: QueryHistoryEntry): void {
    if (entry.queryText === undefined || entry.dml) return
    const connectionId = connections.some((c) => c.id === entry.profileId)
      ? entry.profileId
      : undefined
    workspaceRef.current?.openQuery({
      queryText: entry.queryText,
      connectionId,
      options:
        connectionId && entry.target
          ? { database: entry.target.database, container: entry.target.container }
          : undefined
    })
  }

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
    const lastUsed =
      status === 'disconnected' && connection.lastConnectedAt ? connection.lastConnectedAt : null
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
          {/* Connected rows give the name the room: the dot and border
              already say "connected", and Disconnect moves into the menu. */}
          {status !== 'connected' && (
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
              ...(status === 'connected'
                ? [{ label: 'Disconnect', onSelect: () => void handleDisconnect(connection.id) }]
                : []),
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
        {(connection.environment || connection.readOnly || needsAttention || lastUsed) && (
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
            {lastUsed && (
              <time
                className="conn__last-used"
                dateTime={lastUsed}
                title={new Date(lastUsed).toLocaleString()}
              >
                {formatLastUsed(lastUsed)}
              </time>
            )}
          </div>
        )}
        {message && (
          <p className="conn__message" data-tone={message.tone}>
            {message.text}
          </p>
        )}
        {metadataByConnection[connection.id] && (
          <MetadataTree
            metadata={metadataByConnection[connection.id]}
            canOpen={(object) => canOpenObject(connection, object)}
            onOpen={(object) => handleOpenObject(connection, object)}
          />
        )}
      </li>
    )
  }

  const connectedIds = Object.keys(statuses).filter((id) => statuses[id] === 'connected')
  const connectedCount = connectedIds.length

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
          ref={sidebarRef}
          id="sidebar"
          className="sidebar"
          data-collapsed={rail.collapsed || undefined}
          aria-label="Connections, saved queries and history"
          style={
            rail.collapsed
              ? undefined
              : {
                  gridTemplateRows: `minmax(0, ${split.share}fr) auto minmax(0, ${1 - split.share}fr)`
                }
          }
        >
          {rail.collapsed && (
            <SidebarRail
              connections={connections}
              statuses={statuses}
              onRevealConnection={revealConnection}
              onOpenLibrary={openLibrary}
              onNewConnection={() => {
                setShowNewForm(true)
                rail.setCollapsed(false)
              }}
            />
          )}
          {/* Both areas stay mounted while collapsed (just hidden) so a
              half-filled form or a history search survives. */}
          <section
            className="sidebar__connections"
            aria-labelledby="connections-heading"
            hidden={rail.collapsed}
          >
            {error && (
              <p role="alert" className="sidebar__error">
                {error}
              </p>
            )}
            <div className="section-head">
              <h2 id="connections-heading" className="sidebar__heading">
                Connections
                {connections.length > 0 && (
                  <span className="library__count">{connections.length}</span>
                )}
              </h2>
              <button
                type="button"
                className="btn--ghost section-head__action"
                aria-expanded={showNewForm}
                onClick={() => setShowNewForm((open) => !open)}
              >
                <PlusIcon size={14} /> New connection
              </button>
            </div>

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

            {connections.length === 0
              ? !showNewForm && (
                  <p className="empty">
                    No saved connections yet. Add an Azure SQL Database or Cosmos DB account to
                    start querying.
                  </p>
                )
              : groupKeys.map((key) => {
                  const members = groups.get(key)!
                  const list = <ul className="conn-list">{members.map(renderConnection)}</ul>
                  return key ? (
                    <ConnectionGroup
                      key={key}
                      name={key}
                      count={members.length}
                      forceOpen={members.some((c) => c.id === editingId)}
                      connectedCount={
                        members.filter((c) => statuses[c.id] === 'connected').length
                      }
                    >
                      {list}
                    </ConnectionGroup>
                  ) : (
                    <div key="(ungrouped)" className="conn-group">
                      {list}
                    </div>
                  )
                })}
          </section>

          {!rail.collapsed && <SidebarSplitter split={split} containerRef={sidebarRef} />}

          <div className="sidebar__library" hidden={rail.collapsed}>
            <LibraryPane
              tab={libraryTab}
              onTabChange={setLibraryTab}
              savedCount={savedCount}
              saved={
                <SavedQueriesPanel
                  refreshToken={savedQueriesVersion}
                  connections={connections}
                  onOpen={handleOpenSavedQuery}
                  onCountChange={setSavedCount}
                />
              }
              history={<HistoryPanel connections={connections} onOpen={handleOpenHistoryEntry} />}
            />
          </div>
        </aside>
        {!rail.collapsed && <SidebarResizer {...sidebar} />}

        <main className="workspace">
          <QueryWorkspace
            ref={workspaceRef}
            connections={connections}
            connectedIds={connectedIds}
            onQuerySaved={() => setSavedQueriesVersion((v) => v + 1)}
          />
        </main>
      </div>
    </div>
  )
}

/** Whether an Object Explorer node opens a sample query: a container on
 * Cosmos DB, a table or view on Azure SQL. */
function canOpenObject(connection: ConnectionProfile, object: DatabaseMetadataObject): boolean {
  return connection.config.kind === 'cosmos-db'
    ? object.kind === 'container'
    : object.kind === 'table' || object.kind === 'view'
}

/**
 * Object Explorer tree (user stories 14-17): nested, collapsible via native
 * <details>, showing column types/primary keys/indexes (`detail`) and
 * partition keys. A table/view/container opens a sample query for it, by
 * double-click or by its open button, which also makes it reachable from
 * the keyboard.
 */
function MetadataTree({
  metadata,
  canOpen,
  onOpen
}: {
  metadata: DatabaseMetadata
  canOpen: (object: DatabaseMetadataObject) => boolean
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
          canOpen={canOpen}
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
  canOpen,
  onOpen,
  parentSchema,
  forceOpen,
  openByDefault
}: {
  objects: DatabaseMetadataObject[]
  canOpen: (object: DatabaseMetadataObject) => boolean
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
            {canOpen(withSchema) && (
              <button
                type="button"
                className="btn--ghost tree__open"
                aria-label={`Open ${object.name} in a new query tab`}
                title="Open in a new query tab"
                onClick={(event) => {
                  // Inside a <summary>, a click would also toggle the branch.
                  event.preventDefault()
                  onOpen(withSchema)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <OpenIcon size={12} />
              </button>
            )}
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
                  canOpen={canOpen}
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
