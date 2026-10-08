import { useEffect, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import { NewConnectionForm } from './NewConnectionForm'

export function App(): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionProfile[]>([])
  const [error, setError] = useState<string | null>(null)

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
            {connections.map((connection) => (
              <li key={connection.id}>
                <strong>{connection.name}</strong> — {connection.config.kind}
                {connection.readOnly ? ' (read-only)' : ''}
                {connection.hasSecret ? ' 🔒' : ''}
                <button type="button" onClick={() => handleDelete(connection.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>New connection</h2>
        <NewConnectionForm onCreated={refresh} />
      </section>
    </main>
  )
}
