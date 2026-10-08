import { isRecord } from '@shared/is-record'

/**
 * CSV cell/row/header serialization (user story 49): proper escaping of
 * embedded commas/quotes/newlines, and UTF-8 output (Node strings are
 * already UTF-16 in memory and `fs.writeFile`/`WriteStream` default to
 * UTF-8 on disk — no transcoding step needed here).
 *
 * NULL is rendered as an *empty* field here, not the "NULL" text the
 * results grid shows (see renderer/src/results/cell-format.ts). This is a
 * deliberate difference, not a missed reuse: CSV's empty-string convention
 * for missing data is what spreadsheet/ETL tools consuming the exported
 * file expect, whereas the grid's "NULL" text is for a human reading the
 * QueryForge UI directly.
 *
 * Rows are newline-joined with `\n` (not CRLF) — every consumer this
 * ships for (Excel, Numbers, pandas, etc.) accepts bare `\n`; matching
 * RFC 4180's CRLF exactly isn't worth the extra byte for this MVP.
 */

const NEEDS_QUOTING = /[",\r\n]/

export function csvEscape(text: string): string {
  if (!NEEDS_QUOTING.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

export function csvCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvEscape).join(',')
}

export function csvHeaderRow(columns: readonly string[]): string {
  return csvRow(columns)
}

export function csvDataRow(row: unknown, columns: readonly string[]): string {
  const record = isRecord(row) ? row : {}
  return csvRow(columns.map((column) => csvCellText(record[column])))
}
