import Database from 'better-sqlite3'
import { runMigrations } from './migration-runner'
import { migrations } from './migrations'

/**
 * Opens (creating if needed) the Local Storage Service's SQLite database at
 * `filePath` and brings it up to the latest schema version.
 */
export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, migrations)
  return db
}
