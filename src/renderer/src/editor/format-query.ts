import { format } from 'sql-formatter'
import type { ConnectionConfig } from '@shared/types/connection-profile'

/**
 * Formats query text (user story 20, optional per ticket 04). Returns the
 * input unchanged when the formatter can't parse it — formatting must never
 * lose or corrupt a query. Azure SQL uses the T-SQL dialect. Cosmos NoSQL has
 * no formatter dialect; BigQuery's is the closest that parses its constructs
 * (`@param`, `c["key"]`, `JOIN t IN c.tags`) — the generic and T-SQL dialects
 * reject or mangle them (`c ["key"]`, `@ p`). `VALUE` is not a keyword there,
 * so its case is left as typed.
 */
export function formatQuery(text: string, kind: ConnectionConfig['kind'] | undefined): string {
  try {
    return format(text, {
      language: kind === 'azure-sql' ? 'tsql' : kind === 'cosmos-db' ? 'bigquery' : 'sql',
      keywordCase: 'upper',
      tabWidth: 2
    })
  } catch {
    return text
  }
}
