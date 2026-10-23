import type { StreamingExtractor } from './extractor'

/** Compact JSON per row, one per line, inside a single array — the format
 * the JSON export has always written (Extractors story 24). Always an array, even
 * for one row (Extractors story 26). */
export const jsonExtractor: StreamingExtractor = {
  id: 'json',
  label: 'JSON',
  fileExtension: 'json',
  buffersAllRows: false,
  hasHeader: false,
  usesTableName: false,
  begin: () => '[',
  row: (row, _options, index) => (index > 0 ? ',\n' : '\n') + JSON.stringify(row),
  end: (_options, rowCount) => (rowCount > 0 ? '\n]' : ']')
}

/** One compact JSON document per line, for `jq` and bulk importers (user
 * story 25). */
export const jsonLinesExtractor: StreamingExtractor = {
  id: 'jsonl',
  label: 'JSON Lines',
  fileExtension: 'jsonl',
  buffersAllRows: false,
  hasHeader: false,
  usesTableName: false,
  begin: () => '',
  row: (row, _options, index) => (index > 0 ? '\n' : '') + JSON.stringify(row),
  end: () => ''
}
