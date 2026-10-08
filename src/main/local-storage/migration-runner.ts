import type Database from 'better-sqlite3'
import type { Migration } from './migrations'

/**
 * Applies any `migrations` not yet recorded in `schema_migrations`, in
 * ascending version order, each inside its own transaction. Safe to call on
 * every app startup — already-applied versions are skipped.
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );`
  )

  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version
    )
  )

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, new Date().toISOString())
    })
    applyMigration()
  }
}
