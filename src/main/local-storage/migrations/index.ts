import migration0001 from './0001_create_connection_profiles.sql?raw'
import migration0002 from './0002_create_query_history.sql?raw'
import migration0003 from './0003_create_saved_queries.sql?raw'
import migration0004 from './0004_create_msal_token_cache.sql?raw'
import migration0005 from './0005_add_profile_group_and_last_connected.sql?raw'

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
  { version: 1, name: 'create_connection_profiles', sql: migration0001 },
  { version: 2, name: 'create_query_history', sql: migration0002 },
  { version: 3, name: 'create_saved_queries', sql: migration0003 },
  { version: 4, name: 'create_msal_token_cache', sql: migration0004 },
  { version: 5, name: 'add_profile_group_and_last_connected', sql: migration0005 }
].sort((a, b) => a.version - b.version)
