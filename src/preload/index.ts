import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConnectionProfile,
  CreateConnectionProfileRequest,
  UpdateConnectionProfileRequest
} from '@shared/types/connection-profile'

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

const api = {
  connections: connectionsApi
}

export type QueryForgeApi = typeof api

contextBridge.exposeInMainWorld('api', api)
