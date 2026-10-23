import { joinLines, type BufferingExtractor, type ExtractorId } from './extractor'
import { columnValue, flatText, singleQuoted } from './value-format'

function cells(row: unknown, columns: readonly string[]): string[] {
  return columns.map((column) => flatText(columnValue(row, column)))
}

/**
 * A delimited format (CSV, TSV, Pipe, Semicolon). A value is quoted, with
 * embedded quotes doubled, only when it contains the format's own
 * delimiter, a quote, or a newline (RFC 4180's rule, generalized), so each
 * format round-trips (Extractors story 23). Rows are joined with `\n`, not CRLF:
 * every consumer this ships for (Excel, Numbers, pandas, etc.) accepts
 * bare `\n`. NULL and missing values are empty fields — what spreadsheet
 * and ETL tools expect — not the grid's "NULL" text.
 */
function delimitedExtractor(
  id: ExtractorId,
  label: string,
  fileExtension: string,
  delimiter: string
): BufferingExtractor {
  const escape = (text: string): string =>
    text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  const line = (values: readonly string[]): string => values.map(escape).join(delimiter)

  return {
    id,
    label,
    fileExtension,
    buffersAllRows: true,
    hasHeader: true,
    usesTableName: false,
    render: (rows, columns, options) =>
      joinLines(
        options.includeHeader ? line(columns) : undefined,
        rows.map((row) => line(cells(row, columns)))
      )
  }
}

export const csvExtractor = delimitedExtractor('csv', 'CSV', 'csv', ',')
export const tsvExtractor = delimitedExtractor('tsv', 'TSV', 'tsv', '\t')
export const pipeExtractor = delimitedExtractor('pipe', 'Pipe-separated', 'txt', '|')
export const semicolonExtractor = delimitedExtractor('semicolon', 'Semicolon-separated', 'txt', ';')

/** `|` escaped and newlines as `<br>`, so cell content never breaks the
 * table (Extractors story 28). */
function markdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')
}

export const markdownExtractor: BufferingExtractor = {
  id: 'markdown',
  label: 'Markdown',
  fileExtension: 'md',
  buffersAllRows: true,
  hasHeader: true,
  usesTableName: false,
  render: (rows, columns, options) => {
    if (columns.length === 0) return ''
    const line = (values: readonly string[]): string =>
      `| ${values.map(markdownCell).join(' | ')} |`
    const head = options.includeHeader
      ? `${line(columns)}\n| ${columns.map(() => '---').join(' | ')} |`
      : undefined
    return joinLines(
      head,
      rows.map((row) => line(cells(row, columns)))
    )
  }
}

const PRETTY_MAX_WIDTH = 60

/** One line per cell, at most 60 characters wide, so one long value
 * doesn't wreck the layout (Extractors story 30). */
function prettyCell(text: string): string {
  const oneLine = text.replace(/\r\n|\r|\n/g, '↵')
  return oneLine.length > PRETTY_MAX_WIDTH ? `${oneLine.slice(0, PRETTY_MAX_WIDTH - 1)}…` : oneLine
}

/** An ASCII box-drawn table, columns padded to their widest value, for
 * Slack, terminals and plain-text email (Extractors story 29). The only format
 * that needs every row's text before it can write the first line. */
export const prettyExtractor: BufferingExtractor = {
  id: 'pretty',
  label: 'Pretty',
  fileExtension: 'txt',
  buffersAllRows: true,
  hasHeader: true,
  usesTableName: false,
  render: (rows, columns, options) => {
    if (columns.length === 0 || (rows.length === 0 && !options.includeHeader)) return ''
    const header = columns.map(prettyCell)
    const body = rows.map((row) => cells(row, columns).map(prettyCell))
    const widths = columns.map((_, i) =>
      Math.max(
        options.includeHeader ? header[i].length : 0,
        ...body.map((values) => values[i].length)
      )
    )
    const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`
    const line = (values: readonly string[]): string =>
      `| ${values.map((value, i) => value.padEnd(widths[i])).join(' | ')} |`

    const lines = [border]
    if (options.includeHeader) lines.push(line(header), border)
    if (body.length > 0) lines.push(...body.map(line), border)
    return lines.join('\n')
  }
}

function oneRowValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  return singleQuoted(flatText(value))
}

/** Every value on one comma-separated line, row by row, strings quoted —
 * paste a column straight into an `IN (...)` list (Extractors story 31). */
export const oneRowExtractor: BufferingExtractor = {
  id: 'one-row',
  label: 'One-row',
  fileExtension: 'txt',
  buffersAllRows: true,
  hasHeader: false,
  usesTableName: false,
  render: (rows, columns) =>
    rows.flatMap((row) => columns.map((column) => oneRowValue(columnValue(row, column)))).join(', ')
}
