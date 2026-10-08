import { describe, expect, it } from 'vitest'
import { RecordingExportSink } from './export-sink'
import { JsonArrayWriter } from './json-array-writer'

describe('JsonArrayWriter', () => {
  it('produces an empty array when closed with no rows written', () => {
    const sink = new RecordingExportSink()
    new JsonArrayWriter(sink).close()
    expect(JSON.parse(sink.toString())).toEqual([])
  })

  it('produces a valid JSON array for multiple rows', () => {
    const sink = new RecordingExportSink()
    const writer = new JsonArrayWriter(sink)
    writer.writeRow({ id: 1 })
    writer.writeRow({ id: 2 })
    writer.close()
    expect(JSON.parse(sink.toString())).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('preserves heterogeneous row shapes (no shared schema required)', () => {
    const sink = new RecordingExportSink()
    const writer = new JsonArrayWriter(sink)
    writer.writeRow({ id: 1, name: 'a' })
    writer.writeRow({ id: 2, extra: true })
    writer.close()
    expect(JSON.parse(sink.toString())).toEqual([
      { id: 1, name: 'a' },
      { id: 2, extra: true }
    ])
  })

  it('close() is idempotent', () => {
    const sink = new RecordingExportSink()
    const writer = new JsonArrayWriter(sink)
    writer.writeRow({ id: 1 })
    writer.close()
    writer.close()
    expect(JSON.parse(sink.toString())).toEqual([{ id: 1 }])
  })

  it('throws if written to after close()', () => {
    const writer = new JsonArrayWriter(new RecordingExportSink())
    writer.close()
    expect(() => writer.writeRow({ id: 1 })).toThrow()
  })
})
