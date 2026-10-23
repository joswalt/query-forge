import { describe, expect, it } from 'vitest'
import { extract, EXTRACTORS, getExtractor, type ExtractorOptions } from './extract'

const withHeader: ExtractorOptions = { includeHeader: true, tableName: 'my_table' }
const noHeader: ExtractorOptions = { includeHeader: false, tableName: 'my_table' }

describe('Extractor registry', () => {
  it('falls back to CSV for an unknown Extractor id', () => {
    expect(getExtractor('nope').id).toBe('csv')
  })

  it('gives every Extractor a unique id', () => {
    const ids = EXTRACTORS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('CSV Extractor', () => {
  it('writes a header, then data rows in column order with missing fields empty', () => {
    const rows = [{ id: '1', name: 'a' }, { id: '2', extra: true }]
    expect(extract('csv', rows, ['id', 'name', 'extra'], withHeader)).toBe(
      'id,name,extra\n1,a,\n2,,true'
    )
  })

  it('omits the header when Include header is off', () => {
    expect(extract('csv', [{ a: 1 }, { a: 2 }], ['a'], noHeader)).toBe('1\n2')
  })

  it('quotes values containing commas, quotes, or newlines (RFC 4180)', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2', d: 'l1\rl2' }]
    expect(extract('csv', rows, ['a', 'b', 'c', 'd'], noHeader)).toBe(
      '"x,y","say ""hi""","l1\nl2","l1\rl2"'
    )
  })

  it('renders null and missing values as empty fields, not "NULL"', () => {
    expect(extract('csv', [{ a: null }], ['a', 'b'], noHeader)).toBe(',')
  })

  it('renders nested objects and arrays as compact JSON', () => {
    expect(extract('csv', [{ a: { x: 1 }, b: [1, 2] }], ['a', 'b'], noHeader)).toBe(
      '"{""x"":1}","[1,2]"'
    )
  })

  it('keeps unicode text as-is', () => {
    expect(extract('csv', [{ a: 'café ☕' }], ['a'], noHeader)).toBe('café ☕')
  })

  it('treats a non-object row as all columns empty', () => {
    expect(extract('csv', ['scalar'], ['id'], noHeader)).toBe('')
  })

  it('writes only the header for no rows', () => {
    expect(extract('csv', [], ['a', 'b'], withHeader)).toBe('a,b')
  })
})

describe('JSON Extractor', () => {
  it('writes a valid JSON array preserving nested structure and heterogeneous rows', () => {
    const rows = [{ id: 1, nested: { a: [1, 2] } }, { id: 2, extra: true }]
    const text = extract('json', rows, ['id'], withHeader)
    expect(JSON.parse(text)).toEqual(rows)
    expect(text).toBe('[\n{"id":1,"nested":{"a":[1,2]}},\n{"id":2,"extra":true}\n]')
  })

  it('still produces an array for a single row', () => {
    expect(JSON.parse(extract('json', [{ id: 1 }], ['id'], withHeader))).toEqual([{ id: 1 }])
  })

  it('writes an empty array for no rows', () => {
    expect(extract('json', [], [], withHeader)).toBe('[]')
  })
})
