import type { ExportSink } from './export-sink'

/**
 * Streams a JSON array to an `ExportSink` one row at a time, never holding
 * the full result set in memory to call `JSON.stringify` once at the end.
 * This is what makes `ExportService.exportAll`'s JSON path memory-safe for
 * "export all matching rows" (user story 46) — the CSV path through the
 * same method does *not* get this guarantee (it buffers every row to
 * compute a complete column union first; see export-service.ts's class
 * doc for why that's a deliberate, separate tradeoff). Produces a single
 * valid JSON array document; each
 * row is written as its own compact (non-indented) JSON value, one per
 * line, which keeps the file readable without the overhead of indenting
 * every nested level (user story 49: "JSON exports preserve native JSON
 * structure" — it does not additionally require pretty-printing).
 */
export class JsonArrayWriter {
  private wroteFirst = false
  private closed = false

  constructor(private readonly sink: ExportSink) {
    this.sink.write('[')
  }

  writeRow(row: unknown): void {
    if (this.closed) {
      throw new Error('Cannot write to a JsonArrayWriter after close()')
    }
    this.sink.write(this.wroteFirst ? ',\n' : '\n')
    this.sink.write(JSON.stringify(row))
    this.wroteFirst = true
  }

  /** Writes the closing `]`. Idempotent — safe to call more than once.
   * Must be called even if zero rows were written (produces `[]`). */
  close(): void {
    if (this.closed) return
    this.sink.write(this.wroteFirst ? '\n]' : ']')
    this.closed = true
  }
}
