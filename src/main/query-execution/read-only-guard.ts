import type { ConnectionConfig } from '@shared/types/connection-profile'

/**
 * Statement keywords a read-only Azure SQL connection refuses (user story 59,
 * §8 Security). Scanned across the *whole* script, not just each statement's
 * first word, so `WITH cte AS (...) DELETE ...` and `SELECT ... INTO #t` are
 * still caught.
 */
const FORBIDDEN_SQL_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'DENY',
  'BACKUP',
  'RESTORE',
  'SHUTDOWN',
  'INTO',
  'WRITETEXT',
  'UPDATETEXT',
  'BULK',
  'KILL'
])

export class ReadOnlyViolationError extends Error {
  constructor(keyword: string) {
    super(
      `This connection is read-only: "${keyword}" statements are not allowed. ` +
        'Edit the connection and clear "read-only" to run it.'
    )
    this.name = 'ReadOnlyViolationError'
  }
}

/**
 * Removes comments, string literals, and bracket/quote-delimited identifiers
 * so keyword scanning never trips over (or is evaded by) their contents.
 */
export function stripSqlNoise(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\[(?:[^\]]|\]\])*\]/g, '[]')
}

/**
 * Best-effort guard, *not* a security boundary — the real protection is a
 * database login with read-only permissions. It exists to stop accidental
 * mutation through a connection the user only meant to explore.
 *
 * Cosmos DB for NoSQL's query language is SELECT-only (it cannot mutate
 * data), so a Cosmos connection needs no query inspection here.
 */
export function assertReadOnlyQuery(config: ConnectionConfig, query: string): void {
  if (config.kind !== 'azure-sql') return

  const tokens = stripSqlNoise(query).toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? []
  for (const token of tokens) {
    if (FORBIDDEN_SQL_KEYWORDS.has(token)) throw new ReadOnlyViolationError(token)
  }
}
