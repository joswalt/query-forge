import type { BufferingExtractor, ExtractorOptions } from './extractor'
import { columnValue } from './value-format'

/** The Table field's value when it is blank (user story 39). */
export const FALLBACK_TABLE_NAME = 'my_table'

/**
 * A T-SQL literal inferred from the JS value's type alone, with no
 * column-type metadata lookup (user story 40): numbers bare, booleans
 * `1`/`0`, strings `N'...'` with `''` escaping, NULL for null or a missing
 * key. Nested Cosmos objects/arrays become JSON string literals so no data
 * is lost (user story 41); dates become ISO strings, which Azure SQL
 * converts implicitly to `datetime2`/`datetimeoffset`.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Date) return nString(value.toISOString())
  if (typeof value === 'object') return nString(JSON.stringify(value))
  return nString(String(value))
}

function nString(text: string): string {
  return `N'${text.replace(/'/g, "''")}'`
}

/** A bracket-quoted identifier, `]` doubled. */
export function sqlIdentifier(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`
}

/** The table name as typed (it may be schema-qualified or already
 * bracketed, so it is used verbatim), or the fallback when blank. */
function tableName(options: ExtractorOptions): string {
  return options.tableName.trim() || FALLBACK_TABLE_NAME
}

function insertHead(columns: readonly string[], options: ExtractorOptions): string {
  return `INSERT INTO ${tableName(options)} (${columns.map(sqlIdentifier).join(', ')}) VALUES`
}

function tuple(row: unknown, columns: readonly string[]): string {
  return `(${columns.map((column) => sqlLiteral(columnValue(row, column))).join(', ')})`
}

/** One `INSERT ... VALUES (...)` per row (user story 32). The column list is
 * always written: an INSERT without one silently depends on the target
 * table's column order, so there is no header to toggle. */
export const sqlInsertsExtractor: BufferingExtractor = {
  id: 'sql-inserts',
  label: 'SQL Inserts',
  fileExtension: 'sql',
  buffersAllRows: true,
  hasHeader: false,
  usesTableName: true,
  render: (rows, columns, options) => {
    if (columns.length === 0) return ''
    const head = insertHead(columns, options)
    return rows.map((row) => `${head} ${tuple(row, columns)};`).join('\n')
  }
}

/** T-SQL caps a table value constructor at 1,000 rows per INSERT. */
const MAX_ROWS_PER_INSERT = 1000

/** One INSERT with many VALUES tuples (user story 33), split every 1,000
 * rows so each statement stays within T-SQL's limit. */
export const sqlInsertMultirowExtractor: BufferingExtractor = {
  id: 'sql-insert-multirow',
  label: 'SQL Insert Multirow',
  fileExtension: 'sql',
  buffersAllRows: true,
  hasHeader: false,
  usesTableName: true,
  render: (rows, columns, options) => {
    if (columns.length === 0) return ''
    const head = insertHead(columns, options)
    const statements: string[] = []
    for (let start = 0; start < rows.length; start += MAX_ROWS_PER_INSERT) {
      const tuples = rows
        .slice(start, start + MAX_ROWS_PER_INSERT)
        .map((row) => `  ${tuple(row, columns)}`)
      statements.push(`${head}\n${tuples.join(',\n')};`)
    }
    return statements.join('\n')
  }
}

function equals(column: string, value: unknown): string {
  return value === null || value === undefined
    ? `${sqlIdentifier(column)} IS NULL`
    : `${sqlIdentifier(column)} = ${sqlLiteral(value)}`
}

/** A WHERE clause re-finding exactly these rows across every displayed
 * column (user stories 34-36): `(a = 1 AND b = N'x') OR (...)`, collapsed
 * to `col IN (...)` for a single column. NULLs match with `IS NULL`, since
 * `= NULL` and `IN (NULL)` never match. */
export const whereClauseExtractor: BufferingExtractor = {
  id: 'where-clause',
  label: 'Where Clause',
  fileExtension: 'sql',
  buffersAllRows: true,
  hasHeader: false,
  usesTableName: false,
  render: (rows, columns) => {
    if (rows.length === 0 || columns.length === 0) return ''
    if (columns.length === 1) {
      const [column] = columns
      const values = rows.map((row) => columnValue(row, column))
      const present = values.filter((value) => value !== null && value !== undefined)
      const isNull = `${sqlIdentifier(column)} IS NULL`
      if (present.length === 0) return isNull
      const inList = `${sqlIdentifier(column)} IN (${present.map(sqlLiteral).join(', ')})`
      return present.length < values.length ? `(${inList} OR ${isNull})` : inList
    }
    return rows
      .map(
        (row) =>
          `(${columns.map((column) => equals(column, columnValue(row, column))).join(' AND ')})`
      )
      .join('\nOR ')
  }
}
