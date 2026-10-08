import { computeColumnUnion } from '@shared/column-union'
import type { ExecutionId, QueryOptions } from '@shared/types/database-provider'
import type { ExportFormat } from '@shared/types/export'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import { csvDataRow, csvHeaderRow } from './csv-serialize'
import type { ExportSink } from './export-sink'
import { JsonArrayWriter } from './json-array-writer'

/** `exportAll`'s parameters, bundled rather than seven positional
 * arguments — export-ipc.ts's `ExportAllRequest` (which also carries the
 * IPC-only `destinationPath`) is structurally assignable to this, so the
 * IPC layer passes its request straight through. */
export interface ExportAllRequest {
  profileId: string
  executionId: ExecutionId
  query: string
  options?: QueryOptions
  format: ExportFormat
}

/**
 * Writes query result rows to an `ExportSink` in CSV or JSON (user stories
 * 45-49). Two entry points mirror the UI's explicit "loaded" vs "all
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
 * CSV's fixed header collides with Cosmos's schemaless documents: a CSV
 * header must be written before the first data row, but the full column
 * set isn't known until every row has been seen. For `exportLoadedRows`
 * this is free (the rows are already all in memory). For `exportAll` as
 * CSV, this implementation buffers every streamed row in memory to
 * compute the complete column union before writing a single line — a
 * deliberate, documented tradeoff of CSV's shape against Cosmos's
 * schemaless one, not an oversight. `exportAll` as JSON has no such
 * buffering (`JsonArrayWriter` writes each row as it arrives) and is the
 * recommended format for very large or highly heterogeneous Cosmos
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

  async exportLoadedRows(rows: unknown[], format: ExportFormat, sink: ExportSink): Promise<void> {
    if (format === 'json') {
      const writer = new JsonArrayWriter(sink)
      for (const row of rows) writer.writeRow(row)
      writer.close()
      return
    }

    const columns = computeColumnUnion(rows)
    sink.write(csvHeaderRow(columns))
    for (const row of rows) {
      sink.write('\n' + csvDataRow(row, columns))
    }
  }

  async exportAll(
    request: ExportAllRequest,
    sink: ExportSink,
    onProgress?: (rowsWritten: number) => void
  ): Promise<void> {
    const { profileId, executionId, query, options, format } = request
    const streamOptions: QueryOptions = { ...options, executionId }
    let rowsWritten = 0

    if (format === 'json') {
      const writer = new JsonArrayWriter(sink)
      for await (const chunk of this.client.executeQuery(
        profileId,
        executionId,
        query,
        streamOptions
      )) {
        for (const row of chunk.rows) writer.writeRow(row)
        rowsWritten += chunk.rows.length
        onProgress?.(rowsWritten)
      }
      writer.close()
      return
    }

    // CSV: buffer every row first (see class doc) so the header can
    // reflect every column that appears anywhere in the result.
    const buffered: unknown[] = []
    for await (const chunk of this.client.executeQuery(
      profileId,
      executionId,
      query,
      streamOptions
    )) {
      buffered.push(...chunk.rows)
      rowsWritten += chunk.rows.length
      onProgress?.(rowsWritten)
    }

    const columns = computeColumnUnion(buffered)
    sink.write(csvHeaderRow(columns))
    for (const row of buffered) {
      sink.write('\n' + csvDataRow(row, columns))
    }
  }
}
