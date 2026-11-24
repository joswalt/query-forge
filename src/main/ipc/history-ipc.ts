import { ipcMain } from 'electron'
import type { QueryHistoryEntry, QueryHistoryRepository } from '../local-storage/query-history-repository'
import { searchQueryHistory, type SessionQueryText } from '../query-history/session-query-text'

/**
 * Registers the Query History Entry read surface (user stories 50, 52).
 * Writes happen only as a side effect of a query run, inside
 * `query-execution-ipc.ts`'s `streamQuery` — there is no `history:record`
 * handler here, since the renderer never originates a history entry itself.
 */
export function registerHistoryIpcHandlers(
  repository: QueryHistoryRepository,
  sessionText: SessionQueryText
): void {
  ipcMain.handle(
    'history:list',
    (_event, limit?: number): QueryHistoryEntry[] => sessionText.fill(repository.list(limit))
  )

  ipcMain.handle(
    'history:search',
    (_event, term: string, limit?: number): QueryHistoryEntry[] =>
      searchQueryHistory(repository, sessionText, term, limit)
  )

  // User story 53's retention-control escape hatch — see
  // QueryHistoryRepository.clear()'s doc for why this is a whole-table
  // delete rather than a filtered one.
  ipcMain.handle('history:clear', (): void => {
    repository.clear()
    sessionText.clear()
  })
}
