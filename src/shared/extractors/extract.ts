import { columnValue, flatText } from './value-format'

/**
 * Extractors (GLOSSARY.md): named output formats that turn result rows plus
 * a column list into text. Pure, shared code used by both the renderer
 * (clipboard copy, via `extract`) and main (the Export Service streaming a
 * file, via the pieces), so copied and exported output are byte-identical
 * for the same rows and Extractor (user story 50; ADR 0003).
 */

export type ExtractorId = 'csv' | 'json'

export interface ExtractorOptions {
  includeHeader: boolean
  /** Target table for the SQL Extractors; ignored by every other format. */
  tableName: string
}

/**
 * One Extractor's output, as streaming-friendly pieces: `begin`, then
 * `row` once per row (each returns the full text to append, including any
 * separator before it), then `end`. A format that needs every row before
 * writing anything (Pretty's column widths) implements `render` instead,
 * which takes precedence over the pieces.
 */
export interface Extractor {
  id: ExtractorId
  label: string
  /** Without the dot, e.g. `csv`. */
  fileExtension: string
  /**
   * True when the format needs the full column list (or every row) before
   * its first byte, so "Export all matching" must buffer every streamed row
   * to compute the column union first. False only for formats that write
   * each row as it is (JSON, JSON Lines) and ignore the column list.
   */
  buffersAllRows: boolean
  /** Whether the Include header toggle changes this format's output. */
  hasHeader: boolean
  /** Whether the format uses `ExtractorOptions.tableName`. */
  usesTableName: boolean
  begin(columns: readonly string[], options: ExtractorOptions): string
  row(row: unknown, columns: readonly string[], options: ExtractorOptions, index: number): string
  end(columns: readonly string[], options: ExtractorOptions, rowCount: number): string
  render?(rows: readonly unknown[], columns: readonly string[], options: ExtractorOptions): string
}

function delimitedExtractor(
  id: ExtractorId,
  label: string,
  fileExtension: string,
  delimiter: string
): Extractor {
  const needsQuoting = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : `\\${delimiter}`}]`)
  const escape = (text: string): string =>
    needsQuoting.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  const line = (values: readonly string[]): string => values.map(escape).join(delimiter)

  return {
    id,
    label,
    fileExtension,
    buffersAllRows: true,
    hasHeader: true,
    usesTableName: false,
    begin: (columns, options) => (options.includeHeader ? line(columns) : ''),
    row: (row, columns, options, index) =>
      (index > 0 || options.includeHeader ? '\n' : '') +
      line(columns.map((column) => flatText(columnValue(row, column)))),
    end: () => ''
  }
}

/** Compact JSON per row, one per line, inside a single array — the format
 * the JSON export has always written (user story 24). */
const jsonExtractor: Extractor = {
  id: 'json',
  label: 'JSON',
  fileExtension: 'json',
  buffersAllRows: false,
  hasHeader: false,
  usesTableName: false,
  begin: () => '[',
  row: (row, _columns, _options, index) => (index > 0 ? ',\n' : '\n') + JSON.stringify(row),
  end: (_columns, _options, rowCount) => (rowCount > 0 ? '\n]' : ']')
}

export const EXTRACTORS: readonly Extractor[] = [
  delimitedExtractor('csv', 'CSV', 'csv', ','),
  jsonExtractor
]

export const DEFAULT_EXTRACTOR_ID: ExtractorId = 'csv'

/** The Extractor for `id`, or CSV for an unknown id (e.g. a persisted
 * setting from a newer or older build). */
export function getExtractor(id: string): Extractor {
  return (
    EXTRACTORS.find((extractor) => extractor.id === id) ??
    (EXTRACTORS.find((extractor) => extractor.id === DEFAULT_EXTRACTOR_ID) as Extractor)
  )
}

/** The whole output for in-memory rows: the renderer's copy actions and the
 * Export Service's "Export loaded" both go through this. */
export function extract(
  extractorId: string,
  rows: readonly unknown[],
  columns: readonly string[],
  options: ExtractorOptions
): string {
  const extractor = getExtractor(extractorId)
  if (extractor.render) return extractor.render(rows, columns, options)
  let text = extractor.begin(columns, options)
  rows.forEach((row, index) => {
    text += extractor.row(row, columns, options, index)
  })
  return text + extractor.end(columns, options, rows.length)
}
