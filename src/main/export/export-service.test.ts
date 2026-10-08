import { describe, expect, it } from 'vitest'
import type { ResultChunk } from '@shared/types/database-provider'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import { RecordingExportSink } from './export-sink'
import { ExportService } from './export-service'

/** Minimal fake standing in for `QueryExecutionClient` — `exportAll` only
 * ever calls `executeQuery`, so that's all this needs to implement. */
function fakeClient(chunks: ResultChunk[]): QueryExecutionClient {
  return {
    executeQuery: async function* () {
      for (const chunk of chunks) yield chunk
    }
  } as unknown as QueryExecutionClient
}

describe('ExportService.exportLoadedRows', () => {
  it('writes a valid JSON array of the given rows', async () => {
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient([])).exportLoadedRows(
      [{ id: 1 }, { id: 2 }],
      'json',
      sink
    )
    expect(JSON.parse(sink.toString())).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('writes a CSV header unioned across heterogeneous rows, then data rows', async () => {
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient([])).exportLoadedRows(
      [{ id: '1', name: 'a' }, { id: '2', extra: true }],
      'csv',
      sink
    )
    expect(sink.toString()).toBe('id,name,extra\n1,a,\n2,,true')
  })

  it('writes an empty JSON array for no rows', async () => {
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient([])).exportLoadedRows([], 'json', sink)
    expect(JSON.parse(sink.toString())).toEqual([])
  })
})

describe('ExportService.exportAll', () => {
  it('streams JSON rows from the query execution client without buffering', async () => {
    const chunks: ResultChunk[] = [{ rows: [{ id: 1 }] }, { rows: [{ id: 2 }] }]
    const sink = new RecordingExportSink()
    const progress: number[] = []
    await new ExportService(fakeClient(chunks)).exportAll(
      { profileId: 'profile-1', executionId: 'exec-1', query: 'SELECT * FROM c', format: 'json' },
      sink,
      (n) => progress.push(n)
    )
    expect(JSON.parse(sink.toString())).toEqual([{ id: 1 }, { id: 2 }])
    expect(progress).toEqual([1, 2])
  })

  it('buffers rows to compute a complete CSV header across all streamed chunks', async () => {
    const chunks: ResultChunk[] = [
      { rows: [{ id: '1', name: 'a' }] },
      { rows: [{ id: '2', extra: true }] }
    ]
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient(chunks)).exportAll(
      { profileId: 'profile-1', executionId: 'exec-1', query: 'SELECT * FROM c', format: 'csv' },
      sink
    )
    expect(sink.toString()).toBe('id,name,extra\n1,a,\n2,,true')
  })

  it('propagates a mid-stream failure (e.g. cancellation) instead of resolving as if complete', async () => {
    // Mirrors what both providers' asymmetric cancel() actually does: the
    // async iterator throws partway through (Cosmos's AbortSignal, Azure
    // SQL's Request.cancel() via mssql's 'error' event) rather than
    // closing cleanly — see cosmos-db-provider.ts/azure-sql-provider.ts.
    // export-ipc.ts's temp-file-then-rename only renames on a *resolved*
    // promise, so this guards against exportAll ever swallowing that
    // failure and reporting a truncated export as complete.
    const client = {
      executeQuery: async function* () {
        yield { rows: [{ id: 1 }] }
        throw new Error('cancelled')
      }
    } as unknown as QueryExecutionClient
    const sink = new RecordingExportSink()

    await expect(
      new ExportService(client).exportAll(
        { profileId: 'profile-1', executionId: 'exec-1', query: 'SELECT * FROM c', format: 'json' },
        sink
      )
    ).rejects.toThrow('cancelled')
  })

  it('passes the given executionId through to executeQuery, not a newly minted one', async () => {
    let seenExecutionId: string | undefined
    const client = {
      executeQuery: async function* (_profileId: string, executionId: string) {
        seenExecutionId = executionId
        yield { rows: [{ id: 1 }] }
      }
    } as unknown as QueryExecutionClient
    await new ExportService(client).exportAll(
      { profileId: 'profile-1', executionId: 'exec-xyz', query: 'SELECT * FROM c', format: 'json' },
      new RecordingExportSink()
    )
    expect(seenExecutionId).toBe('exec-xyz')
  })
})
