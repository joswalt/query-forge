import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConnectionProfile,
  CreateConnectionProfileRequest,
  TestConnectionRequest,
  UpdateConnectionProfileRequest
} from '@shared/types/connection-profile'
import type { DatabaseMetadata, TestResult } from '@shared/types/database-provider'

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

const api = {
  connections: connectionsApi,
  queryExecution: queryExecutionApi
}

export type QueryForgeApi = typeof api

contextBridge.exposeInMainWorld('api', api)
