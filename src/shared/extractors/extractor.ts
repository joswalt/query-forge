/**
 * The Extractor contract (GLOSSARY.md): a named output format turning
 * result rows plus a column list into text. See extract.ts for the registry
 * and ADR 0003 for why this is shared between renderer and main.
 */

export type ExtractorId =
  | 'csv'
  | 'tsv'
  | 'pipe'
  | 'semicolon'
  | 'json'
  | 'jsonl'
  | 'markdown'
  | 'pretty'
  | 'one-row'
  | 'sql-inserts'
  | 'sql-insert-multirow'
  | 'where-clause'

export interface ExtractorOptions {
  includeHeader: boolean
  /** Target table for the SQL Extractors; ignored by every other format. */
  tableName: string
}

interface ExtractorInfo {
  id: ExtractorId
  label: string
  /** Without the dot, e.g. `csv`. */
  fileExtension: string
  /** Whether the Include header toggle changes this format's output. */
  hasHeader: boolean
  /** Whether the format uses `ExtractorOptions.tableName`. */
  usesTableName: boolean
}

/**
 * A format that needs the full column list (or every row) before its first
 * byte, so "Export all matching" must buffer every streamed row to compute
 * the column union first. Every column-based format is one of these.
 */
export interface BufferingExtractor extends ExtractorInfo {
  buffersAllRows: true
  render(rows: readonly unknown[], columns: readonly string[], options: ExtractorOptions): string
}

/**
 * A format that writes each row as it is and ignores the column list (JSON,
 * JSON Lines), so "Export all matching" streams it with flat memory: `begin`,
 * then `row` once per row (returning the full text to append, including any
 * separator before it), then `end`.
 */
export interface StreamingExtractor extends ExtractorInfo {
  buffersAllRows: false
  begin(options: ExtractorOptions): string
  row(row: unknown, options: ExtractorOptions, index: number): string
  end(options: ExtractorOptions, rowCount: number): string
}

export type Extractor = BufferingExtractor | StreamingExtractor

/** A whole-input render from per-row text: rows joined by `\n`, after an
 * optional leading block (e.g. a header), which is itself `\n`-separated
 * from the first row. Empty pieces are kept, so a row of all-empty values
 * still takes its line. */
export function joinLines(head: string | undefined, lines: readonly string[]): string {
  return head === undefined ? lines.join('\n') : [head, ...lines].join('\n')
}
