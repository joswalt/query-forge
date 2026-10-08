import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ConnectionManager } from '../connection-manager/connection-manager'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import type {
  QueryHistoryRepository,
  QueryHistoryStatus,
  RecordQueryHistoryInput
} from '../local-storage/query-history-repository'
import type { PreferencesStore } from '../local-storage/preferences-store'
import type { ConnectionProfile, TestConnectionRequest } from '@shared/types/connection-profile'
import type {
  DatabaseMetadata,
  ExecutionId,
  QueryOptions,
  TestResult
} from '@shared/types/database-provider'

/**
 * Registers the Query Execution Service's connection-lifecycle IPC surface
 * (test/connect/disconnect/metadata) — distinct from `connection-ipc.ts`'s
 * Connection Profile CRUD, mirroring the Connection Manager / Query
 * Execution Service component split (§6). The Connection Manager decrypts
 * (or, for an unsaved profile being tested, simply holds) the secret; the
 * Query Execution Client hands it once to the Query Execution Service
 * (ADR 0001) — this file is the only place those two composе.
 *
 * Also records a Query History Entry (user stories 50, 53) after every
 * query run. This lives here rather than in a separate service because the
 * three facts a history entry needs — the query text, the outcome, and
 * (per the note on `cancelledExecutionIds` below) whether a failure was
 * actually a user-requested cancel — all pass through `streamQuery` already;
 * duplicating that in a listener elsewhere would mean re-deriving
 * cancelled-vs-error from only the renderer's side of the boundary.
 */
export function registerQueryExecutionIpcHandlers(
  manager: ConnectionManager,
  client: QueryExecutionClient,
  historyRepository: QueryHistoryRepository,
  preferencesStore: PreferencesStore
): void {
  // Execution IDs the renderer asked to cancel (via `query:cancel` below)
  // but whose `streamQuery` run hasn't yet settled. `executeQuery`'s
  // AsyncIterable throws identically whether a provider's `cancel()` or a
  // genuine failure caused it (GLOSSARY.md: Execution ID's asymmetric
  // semantics) — this set is what lets `streamQuery` record a Query History
  // Entry's status as `cancelled` rather than `error` for that case, since
  // main already knows (export-ipc.ts's equivalent doc notes the renderer
  // normally has to make this call instead; history recording is the one
  // main-side consumer that needs the distinction).
  const cancelledExecutionIds = new Set<ExecutionId>()
  ipcMain.handle(
    'connection:test',
    async (_event, request: TestConnectionRequest): Promise<TestResult> => {
      const { profile, secret } = resolveTestSubject(manager, request)
      return client.testConnection(profile, secret)
    }
  )

  ipcMain.handle('connection:connect', async (_event, profileId: string): Promise<void> => {
    const profile = requireProfile(manager, profileId)
    const secret = manager.revealSecret(profileId)
    await client.connect(profile, secret)
  })

  ipcMain.handle('connection:disconnect', async (_event, profileId: string): Promise<void> => {
    await client.disconnect(profileId)
  })

  ipcMain.handle(
    'connection:getMetadata',
    async (_event, profileId: string): Promise<DatabaseMetadata> => client.getMetadata(profileId)
  )

  // Execution ID minting (GLOSSARY.md: "an opaque identifier the Query
  // Execution Service assigns") lives here, on the main side of the
  // renderer/main boundary — not in the renderer or preload — so the
  // renderer never invents an id the main/utility side didn't agree to.
  // `queryStreamApi.execute` (preload/index.ts) awaits this before
  // attaching its chunk/done/error listeners or sending `query:execute`.
  ipcMain.handle('query:start', (): { executionId: ExecutionId } => ({
    executionId: randomUUID()
  }))

  // Streamed query execution (user stories 24-30) — `send`/event-channel
  // based rather than `invoke`, since a multi-chunk stream has no single
  // reply for `invoke` to return (see preload/index.ts's `queryStreamApi`
  // doc for the full rationale).
  ipcMain.on('query:execute', (event, request: QueryExecuteRequest) => {
    void streamQuery(client, event.sender, request, {
      manager,
      historyRepository,
      preferencesStore,
      cancelledExecutionIds
    })
  })

  ipcMain.on('query:cancel', (_event, request: QueryCancelRequest) => {
    cancelledExecutionIds.add(request.executionId)
    client.cancel(request.profileId, request.executionId)
  })
}

interface QueryExecuteRequest {
  profileId: string
  executionId: ExecutionId
  query: string
  options?: QueryOptions
}

interface QueryCancelRequest {
  profileId: string
  executionId: ExecutionId
}

interface StreamQueryDeps {
  manager: ConnectionManager
  historyRepository: QueryHistoryRepository
  preferencesStore: PreferencesStore
  cancelledExecutionIds: Set<ExecutionId>
}

/**
 * Bridges `QueryExecutionClient.executeQuery`'s `AsyncIterable<ResultChunk>`
 * onto the renderer's per-Execution-ID `query:chunk:*`/`query:done:*`/
 * `query:error:*` channels, and records one Query History Entry per run
 * once it settles. A cancelled run (either provider's asymmetric
 * `cancel()`) surfaces to the renderer identically to a genuine failure —
 * the async iterator simply throws either way — but `cancelledExecutionIds`
 * (populated by the `query:cancel` handler above, before main even asks the
 * Query Execution Service to cancel) lets history recording still tell
 * `cancelled` apart from `error`, since it is scoped to main and sees both
 * sides of that race (see `query-run-reducer.ts`'s `failed` action doc for
 * the equivalent, necessarily-renderer-only distinction the UI itself
 * makes for its own display).
 */
async function streamQuery(
  client: QueryExecutionClient,
  sender: WebContents,
  request: QueryExecuteRequest,
  deps: StreamQueryDeps
): Promise<void> {
  const { profileId, executionId, query, options } = request
  const startedAt = Date.now()
  let rowCount = 0

  try {
    for await (const chunk of client.executeQuery(profileId, executionId, query, options)) {
      rowCount += chunk.rows.length
      if (sender.isDestroyed()) return
      sender.send(`query:chunk:${executionId}`, chunk)
    }
    if (!sender.isDestroyed()) sender.send(`query:done:${executionId}`)
    recordHistory(deps, { profileId, query, status: 'success', startedAt, rowCount })
    if (!sender.isDestroyed()) sender.send('history:updated')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = classifyFailureStatus(deps.cancelledExecutionIds.has(executionId))
    if (!sender.isDestroyed()) sender.send(`query:error:${executionId}`, message)
    recordHistory(deps, {
      profileId,
      query,
      status,
      startedAt,
      rowCount,
      errorMessage: status === 'error' ? message : undefined
    })
    if (!sender.isDestroyed()) sender.send('history:updated')
  } finally {
    deps.cancelledExecutionIds.delete(executionId)
  }
}

interface RecordHistoryInput {
  profileId: string
  query: string
  status: QueryHistoryStatus
  startedAt: number
  rowCount: number
  errorMessage?: string
}

/**
 * Query Execution Service's Execution ID cancellation is asymmetric by
 * provider (GLOSSARY.md), but *this* classification isn't: it only answers
 * "did main already know this execution was asked to cancel", independent
 * of which provider ran it. Pulled out as its own named function (rather
 * than inlined as a ternary) so the status rule has one place to read and
 * unit-test.
 */
export function classifyFailureStatus(wasCancelled: boolean): QueryHistoryStatus {
  return wasCancelled ? 'cancelled' : 'error'
}

/**
 * The pure half of history recording: given the facts `streamQuery` already
 * has plus the two lookups (profile name, the opt-in preference) its caller
 * fetched, decides exactly what gets persisted — notably, *whether* the
 * query text is included at all (user story 53). Kept separate from
 * `recordHistory`'s `try`/`catch` and repository/store calls so this
 * decision is unit-testable without touching SQLite or Electron.
 */
export function toRecordQueryHistoryInput(
  input: RecordHistoryInput,
  profileName: string | undefined,
  persistQueryText: boolean,
  finishedAt: number = Date.now()
): RecordQueryHistoryInput {
  return {
    profileId: input.profileId,
    profileName: profileName ?? '(deleted connection)',
    queryText: persistQueryText ? input.query : undefined,
    status: input.status,
    durationMs: finishedAt - input.startedAt,
    rowCount: input.rowCount,
    errorMessage: input.errorMessage
  }
}

/**
 * Best-effort: a failure recording history must never surface as a query
 * failure to the user, since it would misattribute a bookkeeping problem to
 * their query. Logged to the main process's console rather than silently
 * swallowed, so it's at least visible to whoever's running `npm run dev`.
 */
function recordHistory(deps: StreamQueryDeps, input: RecordHistoryInput): void {
  try {
    const profile = deps.manager.get(input.profileId)
    const { persistQueryText } = deps.preferencesStore.get().queryHistory
    deps.historyRepository.record(
      toRecordQueryHistoryInput(input, profile?.name, persistQueryText)
    )
  } catch (err) {
    console.error('Failed to record query history entry:', err)
  }
}

function requireProfile(manager: ConnectionManager, profileId: string): ConnectionProfile {
  const profile = manager.get(profileId)
  if (!profile) {
    throw new Error(`Connection profile "${profileId}" does not exist`)
  }
  return profile
}

function resolveTestSubject(
  manager: ConnectionManager,
  request: TestConnectionRequest
): { profile: ConnectionProfile; secret: string | undefined } {
  if ('profileId' in request) {
    const profile = requireProfile(manager, request.profileId)
    return { profile, secret: manager.revealSecret(request.profileId) }
  }

  // Test Connection before saving (user story 6) — a profile-shaped object
  // good enough for the Database Provider Interface's `profile` parameter.
  // Never persisted; `id: 'unsaved'` is never looked up anywhere.
  const profile: ConnectionProfile = {
    id: 'unsaved',
    name: 'Test Connection',
    readOnly: false,
    config: request.config,
    hasSecret: request.secret !== undefined,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  }
  return { profile, secret: request.secret }
}
