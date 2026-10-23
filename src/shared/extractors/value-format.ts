import { isRecord } from '../is-record'

/**
 * Value rendering rules shared by every Extractor, so the same value looks
 * the same in every flat format. Nested objects/arrays become compact JSON,
 * matching how the results grid shows them (renderer/src/results/
 * cell-format.ts). Null/missing handling is per format (Extractors story
 * 43), so it's left to each caller rather than baked in here.
 */

/** A column's value from one row; `undefined` when the row lacks the key
 * (heterogeneous Cosmos documents) or isn't an object at all. */
export function columnValue(row: unknown, column: string): unknown {
  return isRecord(row) ? row[column] : undefined
}

/** Flat-format text for a value, with null/undefined rendered as `''`. */
export function flatText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A single-quoted string literal with embedded `'` doubled, as both
 * T-SQL and an `IN (...)` list expect. */
export function singleQuoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}
