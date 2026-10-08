import { useState } from 'react'
import type { ConnectionConfig } from '@shared/types/connection-profile'

interface Props {
  onCreated: () => void
}

/**
 * Minimal Phase 1 connection-creation form: enough fields to exercise the
 * Connection Manager end-to-end over IPC. Full §4.1 field sets (TLS options,
 * Entra ID flows, groups/folders) are later-phase work.
 */
export function NewConnectionForm({ onCreated }: Props): React.JSX.Element {
  const [kind, setKind] = useState<ConnectionConfig['kind']>('azure-sql')
  const [name, setName] = useState('')
  const [server, setServer] = useState('')
  const [database, setDatabase] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [secret, setSecret] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    const config: ConnectionConfig =
      kind === 'azure-sql'
        ? { kind: 'azure-sql', server, database, authMode: 'sql-credentials' }
        : { kind: 'cosmos-db', endpoint, authMode: 'account-key' }

    try {
      await window.api.connections.create({
        name,
        readOnly,
        config,
        secret: secret || undefined
      })
      setName('')
      setServer('')
      setDatabase('')
      setEndpoint('')
      setSecret('')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Database type
        <select value={kind} onChange={(e) => setKind(e.target.value as ConnectionConfig['kind'])}>
          <option value="azure-sql">Azure SQL Database</option>
          <option value="cosmos-db">Azure Cosmos DB for NoSQL</option>
        </select>
      </label>

      <label>
        Connection name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      {kind === 'azure-sql' ? (
        <>
          <label>
            Server hostname
            <input value={server} onChange={(e) => setServer(e.target.value)} required />
          </label>
          <label>
            Database name
            <input value={database} onChange={(e) => setDatabase(e.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        </>
      ) : (
        <>
          <label>
            Cosmos DB endpoint
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          </label>
          <label>
            Account key
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        </>
      )}

      <label>
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(e) => setReadOnly(e.target.checked)}
        />
        Read-only
      </label>

      {error && <p role="alert">{error}</p>}

      <button type="submit" disabled={submitting}>
        Save connection
      </button>
    </form>
  )
}
