import { computeColumnUnion } from '@shared/column-union'
import type { ExecutionId, QueryOptions, ResultChunk } from '@shared/types/database-provider'
import {
  extract,
  getExtractor,
  type ExtractorId,
  type ExtractorOptions
} from '@shared/extractors/extract'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import type { ExportSink } from './export-sink'

/** `exportAll`'s parameters, bundled rather than seven positional
 * arguments — export-ipc.ts's `ExportAllRequest` (which also carries the
 * IPC-only `destinationPath`) is structurally assignable to this, so the
 * IPC layer passes its request straight through. */
export interface ExportAllRequest {
  profileId: string
  executionId: ExecutionId
  query: string
  options?: QueryOptions
  extractorId: ExtractorId
  extractorOptions: ExtractorOptions
  /** Which Result Set of a multi-statement script to write (user story 61);
   * defaults to the first. The script is re-run in full regardless — only
   * rows of this set are written. */
  resultSet?: number
}

/**
 * Writes query result rows to an `ExportSink` through an Extractor (user
 * stories 45-49; ADR 0003: the same shared code the renderer copies with). Two entry points mirror the UI's explicit "loaded" vs "all
 * matching" distinction (user story 47) — they have genuinely different
 * sources and memory characteristics, not just different labels on the
 * same code path:
 *
 * - `exportLoadedRows`: the renderer's already-capped, already-in-memory
 *   row array (bounded by `MAX_DISPLAY_ROWS`, query-run-reducer.ts) — a
 *   single synchronous write, no IPC streaming needed to produce it.
 * - `exportAll`: re-executes the query via the Query Execution Service
 *   under a *new* Execution ID (not the original run's) and streams rows
 *   to disk as they arrive. This is a second RU charge for Cosmos DB —
 *   RUs already spent on the original run are not refunded or reused —
 *   which is exactly the justification spec.md gives for story 47's
 *   required UI distinction between the two export actions.
 *   `executionId` is minted by the caller (export-ipc.ts), the same way
 *   `query:start` mints one for live query execution — so cancelling an
 *   in-progress "export all" is just `client.cancel(profileId,
 *   executionId)`, identical to cancelling a live query, not a new
 *   mechanism.
 *
 * Column-based formats (CSV and the other delimited formats, Markdown,
 * Pretty, One-row, the SQL formats) collide with Cosmos's schemaless
 * documents: a header or column list must be written before the first data
 * row, but the full column set isn't known until every row has been seen.
 * For `exportLoadedRows` this is free (the rows are already all in memory,
 * and the caller passes the grid's columns). For `exportAll`, an Extractor
 * with `buffersAllRows` makes this implementation buffer every streamed row
 * in memory to compute the complete column union before writing a single
 * line — a deliberate, documented tradeoff of those formats' shape against
 * Cosmos's schemaless one, not an oversight. JSON and JSON Lines have no
 * such buffering (each row is written as it arrives) and are the
 * recommended formats for very large or highly heterogeneous Cosmos
 * exports.
 *
 * Deliberate divergence from spec.md's literal wording: spec.md §6 says
 * the Export Service "consumes the same result stream the renderer
 * displays and writes to disk directly from main." Taken literally, that
 * would mean tapping the *original* run's live chunk stream in
 * query-execution-ipc.ts's `streamQuery` as it's forwarded to the
 * renderer. That only works if the decision to export is made *before or
 * during* that run — but user story 45 is "export currently loaded query
 * results," i.e. a decision made *after* the run has already finished
 * (and, for anything past `MAX_DISPLAY_ROWS`, already discarded by the
 * renderer's reducer). There is no live stream left to tap at that point.
 * This implementation instead reads spec.md's parenthetical — "avoids an
 * extra process hop for large result sets" — as the actual design intent:
 * the costly hop to avoid is buffering a large result in the renderer and
 * shipping it back to main. `exportAll` avoids exactly that hop (it
 * streams main-side, never visiting the renderer, at the cost of a second
 * RU charge — made visible to the user per story 47). `exportLoadedRows`
 * is the one path that *does* make that hop, but only for an
 * already-small, bounded array already resident in renderer memory — not
 * the "large result sets" case the spec's parenthetical is about.
 */
export class ExportService {
  constructor(private readonly client: QueryExecutionClient) {}

  /** `columns` is the grid's displayed column list, so the file matches
   * what the user sees (user story 45). */
  async exportLoadedRows(
    rows: unknown[],
    columns: readonly string[],
    extractorId: ExtractorId,
    extractorOptions: ExtractorOptions,
    sink: ExportSink
  ): Promise<void> {
    sink.write(extract(extractorId, rows, columns, extractorOptions))
  }

  async exportAll(
    request: ExportAllRequest,
    sink: ExportSink,
    onProgress?: (rowsWritten: number) => void
  ): Promise<void> {
    const { profileId, executionId, query, options, extractorId, extractorOptions, resultSet = 0 } =
      request
    const extractor = getExtractor(extractorId)
    const streamOptions: QueryOptions = { ...options, executionId }
    let rowsWritten = 0
    const rowsOf = (chunk: ResultChunk): unknown[] =>
      (chunk.resultSet ?? 0) === resultSet ? chunk.rows : []
    const chunks = this.client.executeQuery(profileId, executionId, query, streamOptions)

    if (!extractor.buffersAllRows) {
      // These formats ignore the column list, so each row is written as it
      // arrives and memory stays flat however many rows match.
      sink.write(extractor.begin([], extractorOptions))
      for await (const chunk of chunks) {
        for (const row of rowsOf(chunk)) {
          sink.write(extractor.row(row, [], extractorOptions, rowsWritten))
          rowsWritten += 1
        }
        onProgress?.(rowsWritten)
      }
      sink.write(extractor.end([], extractorOptions, rowsWritten))
      return
    }

    // Buffer every row first (see class doc) so the column list reflects
    // every column that appears anywhere in the result.
    const buffered: unknown[] = []
    for await (const chunk of chunks) {
      const rows = rowsOf(chunk)
      buffered.push(...rows)
      rowsWritten += rows.length
      onProgress?.(rowsWritten)
    }
    sink.write(extract(extractorId, buffered, computeColumnUnion(buffered), extractorOptions))
  }
}
