import { describe, expect, it } from 'vitest'
import { csvCellText, csvDataRow, csvEscape, csvHeaderRow, csvRow } from './csv-serialize'

describe('csvEscape', () => {
  it('leaves plain text untouched', () => {
    expect(csvEscape('hello')).toBe('hello')
  })

  it('quotes text containing a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
  })

  it('quotes and doubles embedded quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes text containing an embedded newline or CR', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('line1\rline2')).toBe('"line1\rline2"')
  })
})

describe('csvCellText', () => {
  it('renders null/undefined as an empty field (not "NULL")', () => {
    expect(csvCellText(null)).toBe('')
    expect(csvCellText(undefined)).toBe('')
  })

  it('stringifies scalars', () => {
    expect(csvCellText(42)).toBe('42')
    expect(csvCellText(true)).toBe('true')
  })

  it('JSON-stringifies nested objects/arrays', () => {
    expect(csvCellText({ a: 1 })).toBe('{"a":1}')
    expect(csvCellText([1, 2])).toBe('[1,2]')
  })
})

describe('csvRow / csvHeaderRow / csvDataRow', () => {
  it('joins escaped values with commas', () => {
    expect(csvRow(['a', 'b,c', 'd'])).toBe('a,"b,c",d')
  })

  it('builds a header row from column names', () => {
    expect(csvHeaderRow(['id', 'name'])).toBe('id,name')
  })

  it('builds a data row in column order, missing fields empty', () => {
    expect(csvDataRow({ id: '1', name: 'Alice' }, ['id', 'name', 'extra'])).toBe('1,Alice,')
  })

  it('tolerates a non-object row (all columns empty)', () => {
    expect(csvDataRow('scalar', ['id'])).toBe('')
  })
})
