import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseMetadata, DatabaseMetadataObject } from '@shared/types/database-provider'
import type { Theme } from '@shared/types/preferences'
import { NewConnectionForm } from './NewConnectionForm'
import { QueryWorkspace, type QueryWorkspaceHandle } from './query-tabs/QueryWorkspace'
import { HistoryPanel } from './history/HistoryPanel'

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
  const [theme, setTheme] = useState<Theme>('light')
  const [editingId, setEditingId] = useState<string | null>(null)
  const workspaceRef = useRef<QueryWorkspaceHandle>(null)

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
      setConnections(await window.api.connections.list())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    refresh()
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
        <li key={connection.id}>
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
    return (
      <li key={connection.id}>
        <strong>{connection.name}</strong> — {connection.config.kind}
        {connection.readOnly ? ' (read-only)' : ''}
        {connection.hasSecret ? ' 🔒' : ''}
        {' — '}
        <span>status: {status}</span>
        <div>
          <button type="button" onClick={() => handleTest(connection.id)}>
            Test
          </button>
          {status === 'connected' ? (
            <button type="button" onClick={() => handleDisconnect(connection.id)}>
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              disabled={status === 'connecting'}
              onClick={() => handleConnect(connection.id)}
            >
              Connect
            </button>
          )}
          <button
            type="button"
            disabled={status !== 'connected'}
            onClick={() => handleBrowseMetadata(connection.id)}
          >
            {metadataByConnection[connection.id] ? 'Refresh metadata' : 'Browse metadata'}
          </button>
          <button type="button" onClick={() => setEditingId(connection.id)}>
            Edit
          </button>
          <button type="button" onClick={() => handleDelete(connection.id)}>
            Delete
          </button>
        </div>
        {testMessages[connection.id] && <p>{testMessages[connection.id]}</p>}
        {metadataByConnection[connection.id] && (
          <MetadataTree
            metadata={metadataByConnection[connection.id]}
            onOpen={(object) => handleOpenObject(connection, object)}
          />
        )}
      </li>
    )
  }

  return (
    <main>
      <h1>
        QueryForge
        <button type="button" onClick={() => void handleToggleTheme()}>
          {theme === 'light' ? '🌙 Dark mode' : '☀️ Light mode'}
        </button>
      </h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>Connections</h2>
        {recents.length > 0 && (
          <p>
            Recent:{' '}
            {recents.map((connection) => (
              <button
                key={connection.id}
                type="button"
                disabled={(statuses[connection.id] ?? 'disconnected') !== 'disconnected'}
                onClick={() => void handleConnect(connection.id)}
              >
                {connection.name}
              </button>
            ))}
          </p>
        )}
        {connections.length === 0 ? (
          <p>No saved connections yet.</p>
        ) : (
          groupKeys.map((key) => (
            <div key={key || '(ungrouped)'}>
              {key && <h3>{key}</h3>}
              <ul>{groups.get(key)!.map(renderConnection)}</ul>
            </div>
          ))
        )}
      </section>

      <section>
        <h2>New connection</h2>
        <NewConnectionForm onCreated={refresh} />
      </section>

      <QueryWorkspace ref={workspaceRef} connections={connections} />

      <HistoryPanel />
    </main>
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
  return (
    <ul>
      {objects.map((object, index) => {
        const withSchema = parentSchema ? { ...object, schema: parentSchema } : object
        const label = `${object.name} (${object.kind}${object.detail ? `: ${object.detail}` : ''})`
        const hasChildren = object.children && object.children.length > 0
        return (
          <li key={`${object.kind}-${object.name}-${index}`}>
            {hasChildren ? (
              <details>
                <summary onDoubleClick={() => onOpen(withSchema)}>{label}</summary>
                <TreeList
                  objects={object.children!}
                  onOpen={onOpen}
                  parentSchema={object.kind === 'schema' ? object.name : parentSchema}
                />
              </details>
            ) : (
              <span onDoubleClick={() => onOpen(withSchema)}>{label}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
