import { useEffect, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseMetadata } from '@shared/types/database-provider'
import { NewConnectionForm } from './NewConnectionForm'
import { QueryWorkspace } from './query-tabs/QueryWorkspace'

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

  return (
    <main>
      <h1>QueryForge</h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>Connections</h2>
        {connections.length === 0 ? (
          <p>No saved connections yet.</p>
        ) : (
          <ul>
            {connections.map((connection) => {
              const status = statuses[connection.id] ?? 'disconnected'
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
                      Browse metadata
                    </button>
                    <button type="button" onClick={() => handleDelete(connection.id)}>
                      Delete
                    </button>
                  </div>
                  {testMessages[connection.id] && <p>{testMessages[connection.id]}</p>}
                  {metadataByConnection[connection.id] && (
                    <MetadataTree metadata={metadataByConnection[connection.id]} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>New connection</h2>
        <NewConnectionForm onCreated={refresh} />
      </section>

      <QueryWorkspace connections={connections} />
    </main>
  )
}

/**
 * Minimal, initial metadata rendering (product-overview.md §11 Phase 2:
 * "Implement initial metadata discovery") — a plain nested list proving
 * `getMetadata()`'s result end-to-end. The real Object Explorer tree
 * widget (user stories 14-17) is later UI-polish work, not this slice.
 */
function MetadataTree({ metadata }: { metadata: DatabaseMetadata }): React.JSX.Element {
  return (
    <ul>
      {metadata.objects.map((object, index) => (
        <li key={`${object.kind}-${object.name}-${index}`}>
          {object.name} ({object.kind})
          {object.children && object.children.length > 0 && (
            <ul>
              {object.children.map((child, childIndex) => (
                <li key={`${child.kind}-${child.name}-${childIndex}`}>
                  {child.name} ({child.kind})
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}
