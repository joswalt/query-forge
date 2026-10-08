import Database from 'better-sqlite3'
import { runMigrations } from '../migration-runner'
import { migrations } from '../migrations'

/** An in-memory, fully-migrated SQLite database for unit tests. */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  runMigrations(db, migrations)
  return db
}
