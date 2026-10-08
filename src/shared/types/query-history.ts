export type QueryHistoryStatus = 'success' | 'error' | 'cancelled'

/**
 * A Query History Entry (GLOSSARY.md) as exposed to the renderer — shared
 * so the preload bridge and the renderer's history UI both type against
 * the same shape the Local Storage Service's `QueryHistoryRepository`
 * returns, mirroring `ConnectionProfile`'s placement in this directory.
 */
export interface QueryHistoryEntry {
  id: string
  profileId: string
  profileName: string
  /** Present only when Preferences opted into persisting query text (user
   * story 53) — withheld by default. */
  queryText: string | undefined
  status: QueryHistoryStatus
  durationMs: number
  rowCount: number | undefined
  errorMessage: string | undefined
  executedAt: string
}
