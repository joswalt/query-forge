import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import type { WriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ExecutionId, QueryOptions } from '@shared/types/database-provider'
import type { ExportFormat } from '@shared/types/export'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import type { ExportService } from '../export/export-service'
import type { ExportSink } from '../export/export-sink'

/**
 * Export IPC surface (user stories 45-48). Deliberately mirrors
 * query-execution-ipc.ts's streaming shape (`query:start` mints an
 * Execution ID, then a `send`-based call plus per-id `chunk`/`done`/
 * `error` — here `progress`/`done`/`error` — channels) rather than
 * inventing a second pattern. Cancelling a running "export all" is the
 * exact same `client.cancel(profileId, executionId)` call that cancels a
 * live query — not a new mechanism (see export-service.ts's class doc).
 *
 * "Export loaded rows" (`export:loaded`) is a single bounded `invoke` with
 * no progress/cancel: its source is already a capped, in-memory array
 * (`MAX_DISPLAY_ROWS`), so the call is fast and finite by construction.
 * "Export all matching rows" (`export:all`) re-executes the query and can
 * run arbitrarily long against a large result set — that is the path with
 * progress reporting and cancellation (user story 48).
 */
export function registerExportIpcHandlers(
  exportService: ExportService,
  client: QueryExecutionClient
): void {
  ipcMain.handle(
    'export:chooseDestination',
    async (event, defaultFileName: string): Promise<string | undefined> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const result = window
        ? await dialog.showSaveDialog(window, { defaultPath: defaultFileName })
        : await dialog.showSaveDialog({ defaultPath: defaultFileName })
      return result.canceled ? undefined : result.filePath
    }
  )

  ipcMain.handle(
    'export:loaded',
    async (
      _event,
      request: { rows: unknown[]; format: ExportFormat; destinationPath: string }
    ): Promise<void> => {
      await writeWithTempFile(request.destinationPath, (sink) =>
        exportService.exportLoadedRows(request.rows, request.format, sink)
      )
    }
  )

  // Execution ID minting lives here, same as `query:start` in
  // query-execution-ipc.ts — the renderer never invents one.
  ipcMain.handle('export:start', (): { executionId: ExecutionId } => ({
    executionId: randomUUID()
  }))

  ipcMain.on('export:all', (event, request: ExportAllRequest) => {
    void runExportAll(exportService, event.sender, request)
  })

  ipcMain.on(
    'export:cancel',
    (_event, request: { profileId: string; executionId: ExecutionId }) => {
      client.cancel(request.profileId, request.executionId)
    }
  )
}

interface ExportAllRequest {
  profileId: string
  executionId: ExecutionId
  query: string
  options?: QueryOptions
  format: ExportFormat
  resultSet?: number
  destinationPath: string
}

async function runExportAll(
  exportService: ExportService,
  sender: WebContents,
  request: ExportAllRequest
): Promise<void> {
  try {
    await writeWithTempFile(request.destinationPath, (sink) =>
      exportService.exportAll(request, sink, (rowsWritten) => {
        if (!sender.isDestroyed()) {
          sender.send(`export:progress:${request.executionId}`, { rowsWritten })
        }
      })
    )
    if (!sender.isDestroyed()) sender.send(`export:done:${request.executionId}`)
  } catch (err) {
    // A cancelled export surfaces identically to a genuine failure here —
    // the async iterator from `client.executeQuery` simply throws either
    // way (same asymmetric-cancel note as query-execution-ipc.ts's
    // `streamQuery`). Distinguishing "cancelled" from "error" is the
    // renderer's job here, since only it knows whether it called
    // `export:cancel` and nothing else in main consumes that distinction.
    // `streamQuery`'s own cancel path differs deliberately, not
    // inconsistently: it persists a Query History Entry whose `status` main
    // itself must get right, so it tracks cancelled Execution IDs
    // main-side instead of leaving the distinction to the renderer alone.
    if (!sender.isDestroyed()) {
      sender.send(
        `export:error:${request.executionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}

/**
 * Partial-file policy (explicit, not left implicit): every write goes to
 * `${destinationPath}.tmp` first; only a *successful* completion renames
 * it to the real destination. A cancelled or failed export deletes the
 * temp file instead — the user's chosen destination path never ends up
 * holding a truncated CSV or an unterminated JSON array.
 *
 * Known MVP limitation: `sink.write` does not honor the WriteStream's
 * backpressure signal (`stream.write()`'s boolean return value) — a very
 * fast producer against a slow disk could grow Node's internal stream
 * buffer unbounded. Acceptable for this MVP's result sizes; revisit if
 * export of very large results proves otherwise in practice.
 */
async function writeWithTempFile(
  destinationPath: string,
  write: (sink: ExportSink) => Promise<void>
): Promise<void> {
  const tempPath = `${destinationPath}.tmp`
  const stream = createWriteStream(tempPath, { encoding: 'utf8' })
  const streamError = new Promise<never>((_resolve, reject) => {
    stream.once('error', reject)
  })
  const sink: ExportSink = {
    write: (text) => {
      stream.write(text)
    }
  }

  try {
    await Promise.race([write(sink), streamError])
    await Promise.race([endStream(stream), streamError])
    await rename(tempPath, destinationPath)
  } catch (err) {
    stream.destroy()
    await unlink(tempPath).catch(() => {})
    throw err
  }
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve))
}
