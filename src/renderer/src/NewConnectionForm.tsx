import { useState } from 'react'
import type {
  AzureSqlAuthMode,
  ConnectionConfig,
  CosmosAuthMode
} from '@shared/types/connection-profile'

interface Props {
  onCreated: () => void
}

/** Each database kind's default auth mode — what `kind`'s <select> resets
 * `authMode` to whenever the user switches database type, so switching
 * from e.g. Cosmos DB to Azure SQL never leaves `authMode` on a value the
 * new kind doesn't even have (`account-key` has no Azure SQL meaning). */
function defaultAuthModeFor(kind: ConnectionConfig['kind']): AzureSqlAuthMode | CosmosAuthMode {
  return kind === 'azure-sql' ? 'sql-credentials' : 'account-key'
}

/**
 * Minimal Phase 1 connection-creation form: enough fields to exercise the
 * Connection Manager end-to-end over IPC. Full §4.1 field sets (TLS
 * options, groups/folders) are later-phase work; Entra ID's clientId/
 * tenantId/redirectUri fields below are intentionally left blank by
 * default (never pre-filled) — a user with no Entra ID app registration
 * simply never fills them in and uses account-key/sql-credentials instead
 * (spec.md Implementation Decisions).
 */
export function NewConnectionForm({ onCreated }: Props): React.JSX.Element {
  const [kind, setKind] = useState<ConnectionConfig['kind']>('azure-sql')
  const [authMode, setAuthMode] = useState<AzureSqlAuthMode | CosmosAuthMode>('sql-credentials')
  const [name, setName] = useState('')
  const [server, setServer] = useState('')
  const [database, setDatabase] = useState('')
  const [username, setUsername] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [secret, setSecret] = useState('')
  const [clientId, setClientId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const isEntraId = authMode === 'entra-id'

  function handleKindChange(nextKind: ConnectionConfig['kind']): void {
    setKind(nextKind)
    setAuthMode(defaultAuthModeFor(nextKind))
  }

  function buildConfig(): ConnectionConfig {
    const entraId = isEntraId ? { clientId, tenantId, redirectUri } : undefined
    return kind === 'azure-sql'
      ? {
          kind: 'azure-sql',
          server,
          database,
          authMode: authMode as AzureSqlAuthMode,
          username: isEntraId ? undefined : username,
          entraId
        }
      : { kind: 'cosmos-db', endpoint, authMode: authMode as CosmosAuthMode, entraId }
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    setTestMessage(null)
    try {
      const result = await window.api.queryExecution.test({
        config: buildConfig(),
        // Entra ID never takes a typed-in secret — main's resolveTestSubject
        // acquires an access token itself (query-execution-ipc.ts), the
        // same as a saved profile's connect(). Stale `secret` state left
        // over from switching auth modes must not leak in regardless.
        secret: isEntraId ? undefined : secret || undefined
      })
      setTestMessage(result.success ? 'Connection OK' : `Failed: ${result.message ?? 'unknown error'}`)
    } catch (err) {
      setTestMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    const config = buildConfig()

    try {
      await window.api.connections.create({
        name,
        readOnly,
        config,
        secret: isEntraId ? undefined : secret || undefined
      })
      setName('')
      setServer('')
      setDatabase('')
      setUsername('')
      setEndpoint('')
      setSecret('')
      setClientId('')
      setTenantId('')
      setRedirectUri('')
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
        <select
          value={kind}
          onChange={(e) => handleKindChange(e.target.value as ConnectionConfig['kind'])}
        >
          <option value="azure-sql">Azure SQL Database</option>
          <option value="cosmos-db">Azure Cosmos DB for NoSQL</option>
        </select>
      </label>

      <label>
        Connection name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <label>
        Authentication
        <select
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as AzureSqlAuthMode | CosmosAuthMode)}
        >
          {kind === 'azure-sql' ? (
            <option value="sql-credentials">SQL username/password</option>
          ) : (
            <option value="account-key">Account key</option>
          )}
          <option value="entra-id">Microsoft Entra ID (sign in with browser)</option>
        </select>
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
          {!isEntraId && (
            <>
              <label>
                SQL username
                <input value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
              <label>
                Password
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </label>
            </>
          )}
        </>
      ) : (
        <>
          <label>
            Cosmos DB endpoint
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          </label>
          {!isEntraId && (
            <label>
              Account key
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
          )}
        </>
      )}

      {isEntraId && (
        <fieldset>
          <legend>
            Entra ID app registration — leave blank if you don&apos;t have one; account-key/SQL
            credentials auth doesn&apos;t need these.
          </legend>
          <label>
            Client ID
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
          </label>
          <label>
            Tenant ID
            <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} required />
          </label>
          <label>
            Redirect URI
            <input
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="http://localhost:PORT"
              required
            />
          </label>
        </fieldset>
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
      {testMessage && <p>{testMessage}</p>}

      <button type="button" disabled={testing} onClick={handleTest}>
        Test connection
      </button>
      <button type="submit" disabled={submitting}>
        Save connection
      </button>
    </form>
  )
}
