import { isRecord } from './is-record'

/**
 * Computes the display columns for a set of result rows as the union of
 * object keys across *all* rows, in first-seen order — not just
 * `Object.keys(rows[0])`. Cosmos DB documents are heterogeneous (GLOSSARY.md:
 * Database Metadata has no fixed "Schema"); deriving columns from row 0
 * alone silently drops fields that only appear on later rows, both in the
 * results grid and in a CSV export's header row.
 *
 * Shared between the renderer (results grid) and main (CSV export's
 * header) so both see exactly the same column set for the same rows.
 */
export function computeColumnUnion(rows: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const columns: string[] = []

  for (const row of rows) {
    if (!isRecord(row)) continue
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }

  return columns
}
