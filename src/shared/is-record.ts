/**
 * Narrows `unknown` to a plain object (excluding arrays and `null`) — the
 * one predicate every row/cell-shaped helper in this codebase needs
 * (`computeColumnUnion`, the results grid, the CSV/JSON export writers),
 * kept in one place rather than redefined at each call site.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
