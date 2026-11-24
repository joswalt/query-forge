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
import type {
  DocumentWrite,
  DocumentWriteResult,
  ReadDocumentRequest,
  ReadDocumentResult
} from '@shared/types/document-writer'
import type { DmlPlanningProgress, DmlPlanSummary } from '@shared/types/dml-run'
import type { ExtractorId, ExtractorOptions } from '@shared/extractors/extract'
import type { QueryHistoryEntry } from '@shared/types/query-history'
import type { Preferences } from '@shared/types/preferences'
import type {
  CreateSavedQueryRequest,
  SavedQuery,
  UpdateSavedQueryRequest
} from '@shared/types/saved-query'

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
    ipcRenderer.invoke('connection:getMetadata', profileId),
  /** Fires when the shared utilityProcess died unexpectedly, dropping every
   * live connection (user story 63). Returns an unsubscribe function. */
  onServiceExited: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('query-execution:service-exited', listener)
    return () => ipcRenderer.removeListener('query-execution:service-exited', listener)
  }
}

export type QueryExecutionApi = typeof queryExecutionApi

/**
 * The renderer's path to Cosmos DB Document Writes and point-reads (ADR
 * 0004), proxied through main to the Query Execution Service. Expected
 * failures (`conflict`, `precondition-failed`, `not-found`) resolve as typed
 * results; a read-only refusal or an unexpected error rejects with a
 * scrubbed message. A read-only Connection Profile is refused in the Query
 * Execution Service whatever the renderer shows.
 */
const documentsApi = {
  write: (profileId: string, write: DocumentWrite): Promise<DocumentWriteResult> =>
    ipcRenderer.invoke('document:write', { profileId, write }),
  read: (profileId: string, request: ReadDocumentRequest): Promise<ReadDocumentResult> =>
    ipcRenderer.invoke('document:read', { profileId, ...request })
}

export type DocumentsApi = typeof documentsApi

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

export interface DmlPlanHandlers {
  onProgress: (progress: DmlPlanningProgress) => void
  onPlanned: (summary: DmlPlanSummary) => void
  onError: (message: string) => void
}

/** Subscribes to an execution's channels before anything is sent, so no
 * event is missed; each terminal handler tears every listener down. */
function listenOnce(
  executionId: string,
  listeners: Record<string, (...args: unknown[]) => void>,
  terminal: string[]
): void {
  const attached = Object.entries(listeners).map(([prefix, listener]) => {
    const channel = `${prefix}:${executionId}`
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
      if (terminal.includes(prefix)) cleanup()
      listener(...args)
    }
    ipcRenderer.on(channel, wrapped)
    return { channel, wrapped }
  })
  function cleanup(): void {
    for (const { channel, wrapped } of attached) ipcRenderer.removeListener(channel, wrapped)
  }
}

/**
 * The renderer's path to DML Statement runs (Cosmos DB, ADR 0004
 * amendments). `plan` runs the Driving Query and holds a DML Plan for the
 * tab; `commit` writes exactly that plan, streaming Write Outcome rows like
 * a query; both are cancelled through the returned handle. `discard` drops
 * a held plan and `releaseTab` drops everything held for a closed tab.
 * Read-only is enforced in the Query Execution Service.
 */
const dmlApi = {
  plan: async (
    profileId: string,
    tabId: string,
    statement: string,
    target: { database?: string; container?: string } | undefined,
    handlers: DmlPlanHandlers
  ): Promise<QueryExecutionHandle> => {
    const { executionId }: { executionId: ExecutionId } = await ipcRenderer.invoke('query:start')
    listenOnce(
      executionId,
      {
        'dml:progress': (progress) => handlers.onProgress(progress as DmlPlanningProgress),
        'dml:planned': (summary) => handlers.onPlanned(summary as DmlPlanSummary),
        'query:error': (message) => handlers.onError(message as string)
      },
      ['dml:planned', 'query:error']
    )
    ipcRenderer.send('dml:plan', {
      profileId,
      tabId,
      executionId,
      statement,
      database: target?.database,
      container: target?.container
    })
    return {
      executionId,
      cancel: () => ipcRenderer.send('query:cancel', { profileId, executionId })
    }
  },
  /** Plans a Retry of the tab's last committed run (`planId`, its plan).
   * The Query Execution Service re-runs that run's own statement, never
   * the editor's. `onPlanned` receives a `DmlRetrySummary`. */
  planRetry: async (
    profileId: string,
    tabId: string,
    planId: string,
    handlers: DmlPlanHandlers
  ): Promise<QueryExecutionHandle> => {
    const { executionId }: { executionId: ExecutionId } = await ipcRenderer.invoke('query:start')
    listenOnce(
      executionId,
      {
        'dml:progress': (progress) => handlers.onProgress(progress as DmlPlanningProgress),
        'dml:planned': (summary) => handlers.onPlanned(summary as DmlPlanSummary),
        'query:error': (message) => handlers.onError(message as string)
      },
      ['dml:planned', 'query:error']
    )
    ipcRenderer.send('dml:planRetry', { planId, tabId, executionId })
    return {
      executionId,
      cancel: () => ipcRenderer.send('query:cancel', { profileId, executionId })
    }
  },
  commit: async (
    profileId: string,
    planId: string,
    handlers: QueryStreamHandlers
  ): Promise<QueryExecutionHandle> => {
    const { executionId }: { executionId: ExecutionId } = await ipcRenderer.invoke('query:start')
    listenOnce(
      executionId,
      {
        'query:chunk': (chunk) => handlers.onChunk(chunk as ResultChunk),
        'query:done': () => handlers.onDone(),
        'query:error': (message) => handlers.onError(message as string)
      },
      ['query:done', 'query:error']
    )
    ipcRenderer.send('dml:commit', { planId, executionId })
    return {
      executionId,
      cancel: () => ipcRenderer.send('query:cancel', { profileId, executionId })
    }
  },
  discard: (planId: string): Promise<void> => ipcRenderer.invoke('dml:discard', planId),
  releaseTab: (tabId: string): Promise<void> => ipcRenderer.invoke('dml:releaseTab', tabId)
}

export type DmlApi = typeof dmlApi

export interface ExportHandle {
  executionId: string
  /** Fire-and-forget, mirroring `QueryStreamApi`'s own `cancel` — the
   * eventual `onDone`/`onError` is what actually tears down listeners. */
  cancel: () => void
}

export interface ExportAllStreamHandlers {
  onProgress: (rowsWritten: number) => void
  onDone: () => void
  onError: (message: string) => void
}

/**
 * The renderer's path to the Export Service (user stories 45-48) —
 * `exportLoaded` is a single bounded call (the source is already a capped,
 * in-memory row array); `exportAll` streams progress the same way
 * `queryStreamApi.execute` streams result chunks, for the same reason
 * (export-ipc.ts's doc: `export:all` can run arbitrarily long against a
 * large result set, so it is the path with progress/cancel).
 *
 * Known MVP limitation: `exportLoaded` structured-clones its entire `rows`
 * array across the renderer→main `invoke` boundary in one call — up to
 * `MAX_DISPLAY_ROWS` (query-run-reducer.ts) rows at once. Acceptable for
 * this MVP's result sizes; a future revision could instead have main read
 * the rows back out of the already-streamed run if this proves slow in
 * practice.
 */
const exportApi = {
  chooseDestination: (defaultFileName: string): Promise<string | undefined> =>
    ipcRenderer.invoke('export:chooseDestination', defaultFileName),

  exportLoaded: (
    rows: unknown[],
    columns: string[],
    extractorId: ExtractorId,
    extractorOptions: ExtractorOptions,
    destinationPath: string
  ): Promise<void> =>
    ipcRenderer.invoke('export:loaded', {
      rows,
      columns,
      extractorId,
      extractorOptions,
      destinationPath
    }),

  exportAll: async (
    profileId: string,
    query: string,
    options: QueryOptions | undefined,
    extractorId: ExtractorId,
    extractorOptions: ExtractorOptions,
    resultSet: number,
    destinationPath: string,
    handlers: ExportAllStreamHandlers
  ): Promise<ExportHandle> => {
    const { executionId }: { executionId: ExecutionId } = await ipcRenderer.invoke('export:start')
    const progressChannel = `export:progress:${executionId}`
    const doneChannel = `export:done:${executionId}`
    const errorChannel = `export:error:${executionId}`

    const onProgress = (_event: IpcRendererEvent, progress: { rowsWritten: number }): void =>
      handlers.onProgress(progress.rowsWritten)
    const onDone = (): void => {
      cleanup()
      handlers.onDone()
    }
    const onError = (_event: IpcRendererEvent, message: string): void => {
      cleanup()
      handlers.onError(message)
    }
    function cleanup(): void {
      ipcRenderer.removeListener(progressChannel, onProgress)
      ipcRenderer.removeListener(doneChannel, onDone)
      ipcRenderer.removeListener(errorChannel, onError)
    }

    ipcRenderer.on(progressChannel, onProgress)
    ipcRenderer.on(doneChannel, onDone)
    ipcRenderer.on(errorChannel, onError)
    ipcRenderer.send('export:all', {
      profileId,
      executionId,
      query,
      options,
      extractorId,
      extractorOptions,
      resultSet,
      destinationPath
    })

    return {
      executionId,
      cancel: () => ipcRenderer.send('export:cancel', { profileId, executionId })
    }
  }
}

export type ExportApi = typeof exportApi

/**
 * The renderer's path to Query History Entries (user stories 50, 52) —
 * read-only from the renderer's side, since entries are only ever written
 * as a side effect of a query run (main's `streamQuery`), never directly.
 * `onUpdated` lets the renderer refresh its list right after a run settles
 * instead of only on a manual refresh or next app launch.
 */
const historyApi = {
  list: (limit?: number): Promise<QueryHistoryEntry[]> => ipcRenderer.invoke('history:list', limit),
  search: (term: string, limit?: number): Promise<QueryHistoryEntry[]> =>
    ipcRenderer.invoke('history:search', term, limit),
  clear: (): Promise<void> => ipcRenderer.invoke('history:clear'),
  onUpdated: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('history:updated', listener)
    return () => ipcRenderer.removeListener('history:updated', listener)
  }
}

export type HistoryApi = typeof historyApi

/** The renderer's path to Preferences (e.g. user story 53's opt-in). */
const preferencesApi = {
  get: (): Promise<Preferences> => ipcRenderer.invoke('preferences:get'),
  update: (patch: Partial<Preferences>): Promise<Preferences> =>
    ipcRenderer.invoke('preferences:update', patch),
  /** Fires after any update, from any part of the UI, with the new
   * Preferences. Returns an unsubscribe function. */
  onUpdated: (callback: (preferences: Preferences) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, preferences: Preferences): void =>
      callback(preferences)
    ipcRenderer.on('preferences:updated', listener)
    return () => ipcRenderer.removeListener('preferences:updated', listener)
  }
}

export type PreferencesApi = typeof preferencesApi

/**
 * The renderer's path to Saved Query CRUD (user story 51) — distinct from
 * `historyApi`'s read-only surface: a Saved Query is deliberately created,
 * named, and edited by the user, not recorded as a side effect.
 */
const savedQueriesApi = {
  list: (): Promise<SavedQuery[]> => ipcRenderer.invoke('savedQuery:list'),
  get: (id: string): Promise<SavedQuery | undefined> => ipcRenderer.invoke('savedQuery:get', id),
  create: (request: CreateSavedQueryRequest): Promise<SavedQuery> =>
    ipcRenderer.invoke('savedQuery:create', request),
  update: (id: string, request: UpdateSavedQueryRequest): Promise<SavedQuery> =>
    ipcRenderer.invoke('savedQuery:update', id, request),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('savedQuery:delete', id)
}

export type SavedQueriesApi = typeof savedQueriesApi

/** Save/open query files through native dialogs (user story 23). */
const filesApi = {
  saveQuery: (defaultName: string, content: string): Promise<string | undefined> =>
    ipcRenderer.invoke('file:saveQuery', defaultName, content),
  openQuery: (): Promise<{ path: string; name: string; content: string } | undefined> =>
    ipcRenderer.invoke('file:openQuery')
}

export type FilesApi = typeof filesApi

const api = {
  connections: connectionsApi,
  queryExecution: queryExecutionApi,
  queryStream: queryStreamApi,
  documents: documentsApi,
  dml: dmlApi,
  export: exportApi,
  history: historyApi,
  preferences: preferencesApi,
  savedQueries: savedQueriesApi,
  files: filesApi
}

export type QueryForgeApi = typeof api

contextBridge.exposeInMainWorld('api', api)
