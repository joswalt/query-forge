import { useState } from 'react'
import type {
  AzureSqlAuthMode,
  ConnectionConfig,
  ConnectionProfile,
  CosmosAuthMode
} from '@shared/types/connection-profile'
import { parseSqlConnectionString } from './connection-string'

interface Props {
  onCreated: () => void
  /** When set, the form edits this saved profile instead of creating one
   * (user story 4). The stored secret is never sent back to the renderer,
   * so a blank secret field means "leave the stored secret untouched". */
  editing?: ConnectionProfile
  onCancel?: () => void
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
export function NewConnectionForm({ onCreated, editing, onCancel }: Props): React.JSX.Element {
  const initial = editing?.config
  const initialSql = initial?.kind === 'azure-sql' ? initial : undefined
  const initialCosmos = initial?.kind === 'cosmos-db' ? initial : undefined
  const [kind, setKind] = useState<ConnectionConfig['kind']>(initial?.kind ?? 'azure-sql')
  const [authMode, setAuthMode] = useState<AzureSqlAuthMode | CosmosAuthMode>(
    initial?.authMode ?? 'sql-credentials'
  )
  const [name, setName] = useState(editing?.name ?? '')
  const [groupName, setGroupName] = useState(editing?.groupName ?? '')
  const [server, setServer] = useState(initialSql?.server ?? '')
  const [database, setDatabase] = useState(initialSql?.database ?? '')
  const [username, setUsername] = useState(initialSql?.username ?? '')
  const [port, setPort] = useState(initialSql?.port ? String(initialSql.port) : '')
  // '' = leave unset (provider default), otherwise an explicit choice.
  const [encrypt, setEncrypt] = useState<'' | 'on' | 'off'>(
    initialSql?.encrypt === undefined ? '' : initialSql.encrypt ? 'on' : 'off'
  )
  const [connectionString, setConnectionString] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [connectionStringMessage, setConnectionStringMessage] = useState<{
    ok: boolean
    lines: string[]
  } | null>(null)
  const [endpoint, setEndpoint] = useState(initialCosmos?.endpoint ?? '')
  const [cosmosDatabase, setCosmosDatabase] = useState(initialCosmos?.database ?? '')
  const [cosmosContainer, setCosmosContainer] = useState(initialCosmos?.container ?? '')
  const [secret, setSecret] = useState('')
  // Client/tenant IDs are shared by both Entra modes (an app registration, or
  // a service principal) so they survive switching between the two.
  const initialAppIdentity = initialSql?.servicePrincipal ?? initial?.entraId
  const [clientId, setClientId] = useState(initialAppIdentity?.clientId ?? '')
  const [tenantId, setTenantId] = useState(initialAppIdentity?.tenantId ?? '')
  const [redirectUri, setRedirectUri] = useState(initial?.entraId?.redirectUri ?? '')
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    initial?.connectionTimeoutMs ? String(initial.connectionTimeoutMs / 1000) : ''
  )
  const [readOnly, setReadOnly] = useState(editing?.readOnly ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const isEntraId = authMode === 'entra-id'
  const isServicePrincipal = authMode === 'service-principal'
  // A saved secret only carries over within the same auth mode (the server
  // drops it on a mode change), so "(unchanged)" must not be offered then.
  const keepsSavedSecret = Boolean(editing?.hasSecret && editing.config.authMode === authMode)

  function handleKindChange(nextKind: ConnectionConfig['kind']): void {
    setKind(nextKind)
    setAuthMode(defaultAuthModeFor(nextKind))
  }

  /** Fills the structured fields from a pasted ADO.NET connection string. The
   * raw string (which may hold a password) is cleared immediately; only the
   * parsed fields reach form state, and the password goes to the secret field. */
  function handleApplyConnectionString(): void {
    const result = parseSqlConnectionString(connectionString)
    if (!result.ok) {
      setPasteOpen(true)
      setConnectionStringMessage({ ok: false, lines: [result.error] })
      return
    }
    const parsed = result.value
    setServer(parsed.server)
    setPort(parsed.port ? String(parsed.port) : '')
    if (parsed.database !== undefined) setDatabase(parsed.database)
    if (parsed.encrypt !== undefined) setEncrypt(parsed.encrypt ? 'on' : 'off')
    setAuthMode(parsed.authMode)
    setUsername(parsed.authMode === 'sql-credentials' ? (parsed.username ?? '') : '')
    // A browser sign-in never uses a typed secret; the other modes take the
    // string's password (SQL password, or the service principal's secret).
    setSecret(parsed.authMode === 'entra-id' ? '' : (parsed.password ?? ''))
    if (parsed.authMode === 'service-principal') setClientId(parsed.clientId ?? '')
    const followUp =
      parsed.authMode === 'entra-id'
        ? ['Entra ID sign-in needs your app registration’s Client ID, Tenant ID and Redirect URI.']
        : []
    setConnectionString('')
    setPasteOpen(false)
    setConnectionStringMessage({
      ok: true,
      lines: ['Fields filled from the connection string.', ...followUp, ...parsed.notes]
    })
  }

  function buildConfig(): ConnectionConfig {
    const entraId = isEntraId ? { clientId, tenantId, redirectUri } : undefined
    const servicePrincipal = isServicePrincipal ? { clientId, tenantId } : undefined
    const connectionTimeoutMs = timeoutSeconds.trim()
      ? Math.round(Number(timeoutSeconds) * 1000)
      : undefined
    // Spread the existing config first so fields this form doesn't expose
    // (port, encrypt, Cosmos database/container) survive an edit.
    return kind === 'azure-sql'
      ? {
          ...initialSql,
          kind: 'azure-sql',
          server,
          port: port.trim() ? Number(port) : undefined,
          encrypt: encrypt === '' ? undefined : encrypt === 'on',
          database,
          authMode: authMode as AzureSqlAuthMode,
          // Set explicitly (not left to the `...initialSql` spread) so
          // switching modes never carries the old mode's fields along.
          username: authMode === 'sql-credentials' ? username : undefined,
          entraId,
          servicePrincipal,
          connectionTimeoutMs
        }
      : {
          ...initialCosmos,
          kind: 'cosmos-db',
          endpoint,
          database: cosmosDatabase.trim() || undefined,
          container: cosmosContainer.trim() || undefined,
          authMode: authMode as CosmosAuthMode,
          entraId,
          connectionTimeoutMs
        }
  }

  async function handleTest(): Promise<void> {
    if (isServicePrincipal && !secret) {
      // An unsaved test can't read the stored secret back (it never leaves main).
      setTestMessage('Enter the client secret to test this connection.')
      return
    }
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
      if (editing) {
        await window.api.connections.update(editing.id, {
          name,
          readOnly,
          config,
          groupName: groupName.trim() || null,
          // Switching to Entra ID drops any stored password/key; otherwise a
          // blank field keeps the existing secret (it's never sent back here).
          secret: isEntraId ? null : secret || undefined
        })
        onCreated()
        return
      }
      await window.api.connections.create({
        name,
        readOnly,
        config,
        groupName: groupName.trim() || undefined,
        secret: isEntraId ? undefined : secret || undefined
      })
      setName('')
      setGroupName('')
      setServer('')
      setDatabase('')
      setUsername('')
      setPort('')
      setEncrypt('')
      setConnectionStringMessage(null)
      setPasteOpen(false)
      setEndpoint('')
      setCosmosDatabase('')
      setCosmosContainer('')
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
    <form className="conn-form" onSubmit={handleSubmit}>
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
        Group (optional)
        <input value={groupName} onChange={(e) => setGroupName(e.target.value)} />
      </label>

      {kind === 'azure-sql' && (
        <details
          className="conn-form__paste"
          open={pasteOpen}
          onToggle={(e) => setPasteOpen(e.currentTarget.open)}
        >
          <summary>Fill from a connection string</summary>
          <div className="conn-form__paste-body">
            <textarea
              aria-label="ADO.NET connection string"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              placeholder="Server=tcp:…;Initial Catalog=…;"
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
            />
            <p className="conn-form__hint">
              Paste the ADO.NET string from the Azure portal. It is cleared once applied.
            </p>
            <button
              type="button"
              disabled={!connectionString.trim()}
              onClick={handleApplyConnectionString}
            >
              Fill fields
            </button>
          </div>
        </details>
      )}
      {kind === 'azure-sql' && connectionStringMessage && (
        <div
          className="conn-form__note"
          role={connectionStringMessage.ok ? 'status' : 'alert'}
          data-ok={connectionStringMessage.ok ? 'true' : 'false'}
        >
          {connectionStringMessage.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      {kind === 'azure-sql' ? (
        <>
          <label>
            Server hostname
            <input value={server} onChange={(e) => setServer(e.target.value)} required />
          </label>
          <div className="conn-form__row">
            <label>
              Port (optional)
              <input
                type="number"
                min="1"
                max="65535"
                placeholder="1433"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label>
              Encryption
              <select
                value={encrypt}
                onChange={(e) => setEncrypt(e.target.value as '' | 'on' | 'off')}
              >
                <option value="">Default (on)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
          <label>
            Database name
            <input value={database} onChange={(e) => setDatabase(e.target.value)} required />
          </label>
        </>
      ) : (
        <>
          <label>
            Cosmos DB endpoint
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} required />
          </label>
          <label>
            Database (optional — leave blank to browse the whole account)
            <input value={cosmosDatabase} onChange={(e) => setCosmosDatabase(e.target.value)} />
          </label>
          <label>
            Container (optional)
            <input value={cosmosContainer} onChange={(e) => setCosmosContainer(e.target.value)} />
          </label>
        </>
      )}

      <label>
        Authentication
        <select
          value={authMode}
          onChange={(e) => setAuthMode(e.target.value as AzureSqlAuthMode | CosmosAuthMode)}
        >
          {kind === 'azure-sql' ? (
            <option value="sql-credentials">SQL username and password</option>
          ) : (
            <option value="account-key">Account key</option>
          )}
          <option value="entra-id">Microsoft Entra ID (browser)</option>
          {kind === 'azure-sql' && <option value="service-principal">Service principal (app secret)</option>}
        </select>
      </label>

      {kind === 'azure-sql' && authMode === 'sql-credentials' && (
        <label>
          SQL username
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
      )}

      {kind === 'azure-sql' && authMode === 'sql-credentials' && (
        <label>
          Password
          <input
            type="password"
            value={secret}
            placeholder={keepsSavedSecret ? '(unchanged)' : ''}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}

      {kind === 'cosmos-db' && !isEntraId && (
        <label>
          Account key
          <input
            type="password"
            value={secret}
            placeholder={keepsSavedSecret ? '(unchanged)' : ''}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}

      {isEntraId && (
        <fieldset>
          <legend>
            Opens your browser to sign in. Needs an Entra app registration (public client) with a
            loopback redirect URI.
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
              placeholder="http://localhost"
              required
            />
          </label>
        </fieldset>
      )}

      {isServicePrincipal && (
        <fieldset>
          <legend>
            Signs in as an app, with no browser. The service principal must exist as a user in the
            database.
          </legend>
          <label>
            Tenant ID
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              spellCheck={false}
              required
            />
          </label>
          <label>
            Client ID
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              spellCheck={false}
              required
            />
          </label>
          <label>
            Client secret
            <input
              type="password"
              value={secret}
              autoComplete="off"
              placeholder={keepsSavedSecret ? '(unchanged)' : ''}
              onChange={(e) => setSecret(e.target.value)}
              required={!keepsSavedSecret}
            />
          </label>
        </fieldset>
      )}

      <label>
        Timeout in seconds (optional)
        <input
          type="number"
          min="1"
          value={timeoutSeconds}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={readOnly}
          onChange={(e) => setReadOnly(e.target.checked)}
        />
        Read-only
      </label>

      {error && <p role="alert">{error}</p>}
      {testMessage && (
        <p
          className="conn-form__test"
          data-ok={testMessage === 'Connection OK' ? 'true' : 'false'}
        >
          {testMessage}
        </p>
      )}

      <div className="conn-form__actions">
        <button type="submit" className="btn--primary" disabled={submitting}>
          {editing ? 'Update connection' : 'Save connection'}
        </button>
        <button type="button" disabled={testing} onClick={handleTest}>
          Test connection
        </button>
        {editing && onCancel && (
          <button type="button" className="btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
