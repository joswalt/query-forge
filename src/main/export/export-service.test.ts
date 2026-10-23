import { describe, expect, it } from 'vitest'
import type { ResultChunk } from '@shared/types/database-provider'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import { computeColumnUnion } from '@shared/column-union'
import { EXTRACTORS, extract, type ExtractorOptions } from '@shared/extractors/extract'
import { RecordingExportSink } from './export-sink'
import { ExportService } from './export-service'

/** Minimal fake standing in for `QueryExecutionClient` — `exportAll` only
 * ever calls `executeQuery`, so that's all this needs to implement. */
const options: ExtractorOptions = { includeHeader: true, tableName: 'my_table' }

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
      ['id'],
      'json',
      options,
      sink
    )
    expect(JSON.parse(sink.toString())).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('writes a CSV header unioned across heterogeneous rows, then data rows', async () => {
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient([])).exportLoadedRows(
      [{ id: '1', name: 'a' }, { id: '2', extra: true }],
      ['id', 'name', 'extra'],
      'csv',
      options,
      sink
    )
    expect(sink.toString()).toBe('id,name,extra\n1,a,\n2,,true')
  })

  it('writes an empty JSON array for no rows', async () => {
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient([])).exportLoadedRows([], [], 'json', options, sink)
    expect(JSON.parse(sink.toString())).toEqual([])
  })
})

describe('ExportService.exportAll', () => {
  it('streams JSON rows from the query execution client without buffering', async () => {
    const chunks: ResultChunk[] = [{ rows: [{ id: 1 }] }, { rows: [{ id: 2 }] }]
    const sink = new RecordingExportSink()
    const progress: number[] = []
    await new ExportService(fakeClient(chunks)).exportAll(
      { profileId: 'profile-1', executionId: 'exec-1', query: 'SELECT * FROM c', extractorId: 'json', extractorOptions: options },
      sink,
      (n) => progress.push(n)
    )
    expect(JSON.parse(sink.toString())).toEqual([{ id: 1 }, { id: 2 }])
    expect(progress).toEqual([1, 2])
  })

  it('writes only the selected Result Set of a multi-statement script (user story 61)', async () => {
    const chunks: ResultChunk[] = [
      { rows: [], resultSet: 0 },
      { rows: [{ a: 1 }], resultSet: 0 },
      { rows: [{ b: 1 }, { b: 2 }], resultSet: 1 },
      { rows: [{ b: 3 }], resultSet: 1 }
    ]
    const request = { profileId: 'p', executionId: 'e', query: 'q' }

    const json = new RecordingExportSink()
    const progress: number[] = []
    await new ExportService(fakeClient(chunks)).exportAll(
      { ...request, extractorId: 'json', extractorOptions: options, resultSet: 1 },
      json,
      (n) => progress.push(n)
    )
    expect(JSON.parse(json.toString())).toEqual([{ b: 1 }, { b: 2 }, { b: 3 }])
    expect(progress.at(-1)).toBe(3)

    const csv = new RecordingExportSink()
    await new ExportService(fakeClient(chunks)).exportAll({ ...request, extractorId: 'csv', extractorOptions: options }, csv)
    expect(csv.toString()).toBe('a\n1')
  })

  it('buffers rows to compute a complete CSV header across all streamed chunks', async () => {
    const chunks: ResultChunk[] = [
      { rows: [{ id: '1', name: 'a' }] },
      { rows: [{ id: '2', extra: true }] }
    ]
    const sink = new RecordingExportSink()
    await new ExportService(fakeClient(chunks)).exportAll(
      { profileId: 'profile-1', executionId: 'exec-1', query: 'SELECT * FROM c', extractorId: 'csv', extractorOptions: options },
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
        { profileId: 'profile-1', executionId: 'exec-1', query: 'SELECT * FROM c', extractorId: 'json', extractorOptions: options },
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
      { profileId: 'profile-1', executionId: 'exec-xyz', query: 'SELECT * FROM c', extractorId: 'json', extractorOptions: options },
      new RecordingExportSink()
    )
    expect(seenExecutionId).toBe('exec-xyz')
  })
})

describe('ExportService parity with extract (user story 50)', () => {
  const rows = [
    { id: 1, name: 'a', nested: { x: [1, 2] } },
    { id: 2, extra: 'with, comma' },
    { id: 3, name: null }
  ]
  const chunks: ResultChunk[] = [{ rows: rows.slice(0, 2) }, { rows: rows.slice(2) }]

  for (const extractor of EXTRACTORS) {
    it(`writes exactly what extract() produces as ${extractor.label}`, async () => {
      const columns = computeColumnUnion(rows)
      const expected = extract(extractor.id, rows, columns, options)

      const loaded = new RecordingExportSink()
      await new ExportService(fakeClient([])).exportLoadedRows(
        rows,
        columns,
        extractor.id,
        options,
        loaded
      )
      expect(loaded.toString()).toBe(expected)

      const all = new RecordingExportSink()
      await new ExportService(fakeClient(chunks)).exportAll(
        { profileId: 'p', executionId: 'e', query: 'q', extractorId: extractor.id, extractorOptions: options },
        all
      )
      expect(all.toString()).toBe(expected)
    })
  }
})
