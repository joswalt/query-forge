import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ConnectionManager } from '../connection-manager/connection-manager'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
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
 */
export function registerQueryExecutionIpcHandlers(
  manager: ConnectionManager,
  client: QueryExecutionClient
): void {
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
    void streamQuery(client, event.sender, request)
  })

  ipcMain.on('query:cancel', (_event, request: QueryCancelRequest) => {
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

/**
 * Bridges `QueryExecutionClient.executeQuery`'s `AsyncIterable<ResultChunk>`
 * onto the renderer's per-Execution-ID `query:chunk:*`/`query:done:*`/
 * `query:error:*` channels. A cancelled run (either provider's asymmetric
 * `cancel()`) surfaces here identically to a genuine failure — the async
 * iterator simply throws either way; distinguishing "cancelled" from
 * "error" is the renderer's job, since only it knows whether it called
 * `queryStream.cancel()` (see query-run-reducer.ts's `failed` action doc).
 */
async function streamQuery(
  client: QueryExecutionClient,
  sender: WebContents,
  request: QueryExecuteRequest
): Promise<void> {
  const { profileId, executionId, query, options } = request
  try {
    for await (const chunk of client.executeQuery(profileId, executionId, query, options)) {
      if (sender.isDestroyed()) return
      sender.send(`query:chunk:${executionId}`, chunk)
    }
    if (!sender.isDestroyed()) sender.send(`query:done:${executionId}`)
  } catch (err) {
    if (!sender.isDestroyed()) {
      sender.send(`query:error:${executionId}`, err instanceof Error ? err.message : String(err))
    }
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
