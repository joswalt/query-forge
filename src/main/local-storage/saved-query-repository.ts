import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  CreateSavedQueryRequest,
  SavedQuery,
  SavedQueryDatabaseKind,
  UpdateSavedQueryRequest
} from '@shared/types/saved-query'

export type { SavedQuery }

export type CreateSavedQueryInput = CreateSavedQueryRequest
export type UpdateSavedQueryInput = UpdateSavedQueryRequest

interface SavedQueryRow {
  id: string
  name: string
  query_text: string
  profile_id: string | null
  database_kind: SavedQueryDatabaseKind | null
  created_at: string
  updated_at: string
}

/**
 * Local Storage Service component owning Saved Query persistence
 * (GLOSSARY.md: "Saved Query", user story 51). Deliberately created/named by
 * the user, unlike Query History Entries which are recorded automatically —
 * see QueryHistoryRepository's doc for that distinction.
 */
export class SavedQueryRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateSavedQueryInput): SavedQuery {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO saved_queries (id, name, query_text, profile_id, database_kind, created_at, updated_at)
         VALUES (@id, @name, @queryText, @profileId, @databaseKind, @createdAt, @updatedAt)`
      )
      .run({
        id,
        name: input.name,
        queryText: input.queryText,
        profileId: input.profileId ?? null,
        databaseKind: input.databaseKind ?? null,
        createdAt: now,
        updatedAt: now
      })
    return this.get(id)!
  }

  get(id: string): SavedQuery | undefined {
    const row = this.db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(id) as
      | SavedQueryRow
      | undefined
    return row ? toSavedQuery(row) : undefined
  }

  /** Most-recently-updated first (mirrors a Saved Query's edit becoming its
   * freshest state) — `rowid` breaks ties within the same millisecond, same
   * rationale as QueryHistoryRepository.list(). */
  list(): SavedQuery[] {
    const rows = this.db
      .prepare('SELECT * FROM saved_queries ORDER BY updated_at DESC, rowid DESC')
      .all() as SavedQueryRow[]
    return rows.map(toSavedQuery)
  }

  update(id: string, input: UpdateSavedQueryInput): SavedQuery {
    const existing = this.get(id)
    if (!existing) throw new Error(`Saved query not found: ${id}`)

    const name = input.name ?? existing.name
    const queryText = input.queryText ?? existing.queryText
    const profileId = input.profileId === undefined ? (existing.profileId ?? null) : input.profileId
    const databaseKind =
      input.databaseKind === undefined ? (existing.databaseKind ?? null) : input.databaseKind
    const updatedAt = new Date().toISOString()

    this.db
      .prepare(
        `UPDATE saved_queries
         SET name = @name, query_text = @queryText, profile_id = @profileId,
             database_kind = @databaseKind, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({ id, name, queryText, profileId, databaseKind, updatedAt })

    return this.get(id)!
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id)
  }
}

function toSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    queryText: row.query_text,
    profileId: row.profile_id ?? undefined,
    databaseKind: row.database_kind ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
