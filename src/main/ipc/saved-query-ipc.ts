import { ipcMain } from 'electron'
import type {
  CreateSavedQueryInput,
  SavedQueryRepository,
  UpdateSavedQueryInput
} from '../local-storage/saved-query-repository'

/**
 * Registers the Saved Query CRUD surface (user story 51). Mirrors
 * connection-ipc.ts: thin request/response glue over the repository, no
 * logic of its own — the renderer never touches SQLite directly (§6).
 */
export function registerSavedQueryIpcHandlers(repository: SavedQueryRepository): void {
  ipcMain.handle('savedQuery:list', () => repository.list())
  ipcMain.handle('savedQuery:get', (_event, id: string) => repository.get(id))
  ipcMain.handle('savedQuery:create', (_event, input: CreateSavedQueryInput) =>
    repository.create(input)
  )
  ipcMain.handle('savedQuery:update', (_event, id: string, input: UpdateSavedQueryInput) =>
    repository.update(id, input)
  )
  ipcMain.handle('savedQuery:delete', (_event, id: string) => repository.delete(id))
}
