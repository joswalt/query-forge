/**
 * Cell text formatting for the results grid and "Copy cell" (user stories
 * 38-39) — a plain, DOM-free function so it's unit-testable with Vitest (no
 * jsdom/@testing-library in this repo; see spec.md's Testing Decisions).
 *
 * Deliberately *not* what the Extractors (src/shared/extractors/) render:
 * the flat formats leave NULL as an empty field (what spreadsheet/ETL tools
 * expect), whereas the grid's "NULL" text is for a human reading the
 * QueryForge UI directly, where a blank would be indistinguishable from an
 * empty string.
 */

/** Explicit "NULL" text for a null/undefined cell (user story 38) — never a
 * blank cell, which would be indistinguishable from an empty string. */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
