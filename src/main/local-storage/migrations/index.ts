import migration0001 from './0001_create_connection_profiles.sql?raw'

export interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Ordered schema migrations for the Local Storage Service's SQLite database
 * (map.md ticket 07: "hand-rolled schema migrations — version table +
 * ordered .sql files, no migration library"). Each migration's `.sql` file
 * stays a standalone, versioned file on disk; it is statically imported here
 * (via Vite's `?raw` loader) rather than read from disk at runtime so the
 * migration text survives Electron/Vite bundling without a separate
 * asset-copy build step.
 */
export const migrations: Migration[] = [
  { version: 1, name: 'create_connection_profiles', sql: migration0001 }
].sort((a, b) => a.version - b.version)
