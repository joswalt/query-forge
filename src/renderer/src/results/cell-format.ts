import { isRecord } from '@shared/is-record'

/**
 * Shared cell/row text formatting for the results grid and clipboard copy
 * (user stories 38-39) — kept as plain, DOM-free functions so they're
 * unit-testable with Vitest (no jsdom/@testing-library in this repo; see
 * spec.md's Testing Decisions).
 *
 * This is renderer-only and is *not* reused by the CSV exporter
 * (src/main/export/csv-serialize.ts), despite looking similar: CSV
 * deliberately renders NULL as an empty field rather than the "NULL" text
 * here, so the two have different, intentionally-divergent formatting
 * rules, documented at csv-serialize.ts's own `csvCellText`.
 */

/** Explicit "NULL" text for a null/undefined cell (user story 38) — never a
 * blank cell, which would be indistinguishable from an empty string. */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Tab-separated text for one row across the given columns, in column
 * order — the clipboard format for both "copy row" and "copy selected
 * rows" (user story 39), and paste-compatible with spreadsheet apps. */
export function buildRowCopyText(row: unknown, columns: readonly string[]): string {
  const record = isRecord(row) ? row : {}
  return columns.map((column) => formatCellValue(record[column])).join('\t')
}

/** Multiple rows' TSV text, one row per line, in the given row order. */
export function buildRowsCopyText(rows: readonly unknown[], columns: readonly string[]): string {
  return rows.map((row) => buildRowCopyText(row, columns)).join('\n')
}
