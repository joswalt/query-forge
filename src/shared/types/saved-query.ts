import type { ConnectionConfig } from './connection-profile'

/** Mirrors `ConnectionConfig['kind']` — kept as its own alias so a Saved
 * Query's database association reads as "which kind of database", not
 * "which connection config shape", even though the values are identical. */
export type SavedQueryDatabaseKind = ConnectionConfig['kind']

/**
 * A Saved Query (GLOSSARY.md) — a user-named, reusable query text, optionally
 * associated with a specific Connection Profile and/or a database kind
 * (user story 51). Distinct from a Query History Entry: history is
 * automatic and append-only; a Saved Query is deliberately created, named,
 * and editable by the user.
 */
export interface SavedQuery {
  id: string
  name: string
  queryText: string
  profileId: string | undefined
  databaseKind: SavedQueryDatabaseKind | undefined
  createdAt: string
  updatedAt: string
}

/** Shared request shape for creating a Saved Query — used by both the
 * preload bridge and `SavedQueryRepository` itself, mirroring
 * `CreateConnectionProfileRequest`'s placement for the same reason. */
export interface CreateSavedQueryRequest {
  name: string
  queryText: string
  profileId?: string
  databaseKind?: SavedQueryDatabaseKind
}

export interface UpdateSavedQueryRequest {
  name?: string
  queryText?: string
  /** `null` clears the association; `undefined` leaves it untouched. */
  profileId?: string | null
  databaseKind?: SavedQueryDatabaseKind | null
}
