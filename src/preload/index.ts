import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  ConnectionProfile,
  CreateConnectionProfileRequest,
  TestConnectionRequest,
  UpdateConnectionProfileRequest
} from '@shared/types/connection-profile'
import type {
  DatabaseMetadata,
  ExecutionId,
  QueryOptions,
  ResultChunk,
  TestResult
} from '@shared/types/database-provider'

/**
 * The renderer's only path to Connection Manager data — never direct SQLite,
 * safeStorage, or DB-driver access (§6 component boundaries). `secret` is
 * sent as plaintext over this bridge once, for the main process to encrypt
 * immediately; it is never echoed back in any response.
 */
const connectionsApi = {
  list: (): Promise<ConnectionProfile[]> => ipcRenderer.invoke('connection:list'),
  get: (id: string): Promise<ConnectionProfile | undefined> =>
    ipcRenderer.invoke('connection:get', id),
  create: (request: CreateConnectionProfileRequest): Promise<ConnectionProfile> =>
    ipcRenderer.invoke('connection:create', request),
  update: (id: string, request: UpdateConnectionProfileRequest): Promise<ConnectionProfile> =>
    ipcRenderer.invoke('connection:update', id, request),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('connection:delete', id)
}

export type ConnectionsApi = typeof connectionsApi

/**
 * The renderer's path to the Query Execution Service's connection
 * lifecycle (test/connect/disconnect/metadata) — distinct from
 * `connectionsApi`'s Connection Profile CRUD, mirroring the Connection
 * Manager / Query Execution Service split (§6). Never touches DB drivers
 * directly; every call is proxied through main.
 */
const queryExecutionApi = {
  test: (request: TestConnectionRequest): Promise<TestResult> =>
    ipcRenderer.invoke('connection:test', request),
  connect: (profileId: string): Promise<void> => ipcRenderer.invoke('connection:connect', profileId),
  disconnect: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('connection:disconnect', profileId),
  getMetadata: (profileId: string): Promise<DatabaseMetadata> =>
    ipcRenderer.invoke('connection:getMetadata', profileId)
}

export type QueryExecutionApi = typeof queryExecutionApi

export interface QueryExecutionHandle {
  /** The id main minted for this run — exposed so the renderer can
   * correlate progress with the tab that started it. */
  executionId: string
  /** Asymmetric by design (GLOSSARY.md: Execution ID) — fire-and-forget,
   * same as `queryExecutionApi`'s own `cancel`. Does *not* detach the
   * chunk/done/error listeners itself: the eventual `onDone`/`onError`
   * callback (which the cancel always produces one or the other of) is
   * what tears them down, so a cancelled run's outcome is never missed. */
  cancel: () => void
}

export interface QueryStreamHandlers {
  onChunk: (chunk: ResultChunk) => void
  onDone: () => void
  onError: (message: string) => void
}

/**
 * The renderer's path to streamed query execution (user stories 24-30) —
 * distinct from `queryExecutionApi` (connection lifecycle: test/connect/
 * disconnect/metadata, all simple request/response). `ipcRenderer.invoke`
 * cannot model a multi-chunk stream, so this uses `send` plus a
 * per-execution pair of listener channels instead.
 *
 * The Execution ID itself is minted by main (`query:start`), not here:
 * GLOSSARY.md assigns that responsibility to the Query Execution Service
 * side of the boundary, not the renderer. `execute` awaits that mint,
 * attaches its listeners, and only then sends `query:execute` — so
 * streaming never starts before the renderer is listening for it.
 */
const queryStreamApi = {
  execute: async (
    profileId: string,
    query: string,
    options: QueryOptions | undefined,
    handlers: QueryStreamHandlers
  ): Promise<QueryExecutionHandle> => {
    const { executionId }: { executionId: ExecutionId } = await ipcRenderer.invoke('query:start')
    const chunkChannel = `query:chunk:${executionId}`
    const doneChannel = `query:done:${executionId}`
    const errorChannel = `query:error:${executionId}`

    const onChunk = (_event: IpcRendererEvent, chunk: ResultChunk): void => handlers.onChunk(chunk)
    const onDone = (): void => {
      cleanup()
      handlers.onDone()
    }
    const onError = (_event: IpcRendererEvent, message: string): void => {
      cleanup()
      handlers.onError(message)
    }
    function cleanup(): void {
      ipcRenderer.removeListener(chunkChannel, onChunk)
      ipcRenderer.removeListener(doneChannel, onDone)
      ipcRenderer.removeListener(errorChannel, onError)
    }

    ipcRenderer.on(chunkChannel, onChunk)
    ipcRenderer.on(doneChannel, onDone)
    ipcRenderer.on(errorChannel, onError)
    ipcRenderer.send('query:execute', { profileId, executionId, query, options })

    return {
      executionId,
      cancel: () => ipcRenderer.send('query:cancel', { profileId, executionId })
    }
  }
}

export type QueryStreamApi = typeof queryStreamApi

const api = {
  connections: connectionsApi,
  queryExecution: queryExecutionApi,
  queryStream: queryStreamApi
}

export type QueryForgeApi = typeof api

contextBridge.exposeInMainWorld('api', api)
