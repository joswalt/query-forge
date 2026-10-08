import { ipcMain } from 'electron'
import type { ConnectionManager } from '../connection-manager/connection-manager'
import type {
  CreateConnectionProfileRequest,
  UpdateConnectionProfileRequest
} from '@shared/types/connection-profile'

/**
 * Registers the Connection Manager's IPC surface. The renderer never
 * touches SQLite, safeStorage, or DB drivers directly — every call is
 * proxied through contextBridge + IPC to main (§6 component boundaries,
 * map.md ticket 10).
 */
export function registerConnectionIpcHandlers(manager: ConnectionManager): void {
  ipcMain.handle('connection:list', () => manager.list())
  ipcMain.handle('connection:get', (_event, id: string) => manager.get(id))
  ipcMain.handle('connection:create', (_event, request: CreateConnectionProfileRequest) =>
    manager.create(request)
  )
  ipcMain.handle(
    'connection:update',
    (_event, id: string, request: UpdateConnectionProfileRequest) => manager.update(id, request)
  )
  ipcMain.handle('connection:delete', (_event, id: string) => manager.delete(id))
}
