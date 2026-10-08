/**
 * The write target `ExportService` writes text chunks to. Kept to this one
 * method deliberately — opening the destination file, handling the
 * temp-file-then-rename dance (export-ipc.ts), and closing/flushing all
 * stay out of the pure export core, so `ExportService`'s tests run against
 * a fake sink that just records what it was given, with no real
 * filesystem involved.
 */
export interface ExportSink {
  write(text: string): void
}

/** Test/dev-friendly sink that accumulates everything written to it. */
export class RecordingExportSink implements ExportSink {
  private chunks: string[] = []

  write(text: string): void {
    this.chunks.push(text)
  }

  toString(): string {
    return this.chunks.join('')
  }
}
