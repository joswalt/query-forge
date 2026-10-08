import { describe, expect, it } from 'vitest'
import { buildRowCopyText, buildRowsCopyText, formatCellValue } from './cell-format'

describe('formatCellValue', () => {
  it('renders null and undefined as the literal "NULL"', () => {
    expect(formatCellValue(null)).toBe('NULL')
    expect(formatCellValue(undefined)).toBe('NULL')
  })

  it('renders an empty string as itself, distinct from NULL', () => {
    expect(formatCellValue('')).toBe('')
  })

  it('stringifies numbers and booleans', () => {
    expect(formatCellValue(42)).toBe('42')
    expect(formatCellValue(false)).toBe('false')
  })

  it('JSON-stringifies objects and arrays', () => {
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}')
    expect(formatCellValue([1, 2])).toBe('[1,2]')
  })
})

describe('buildRowCopyText', () => {
  it('joins formatted column values with tabs, in column order', () => {
    const row = { b: 2, a: 1 }
    expect(buildRowCopyText(row, ['a', 'b'])).toBe('1\t2')
  })

  it('renders a missing column as NULL', () => {
    expect(buildRowCopyText({ a: 1 }, ['a', 'missing'])).toBe('1\tNULL')
  })

  it('tolerates a non-object row', () => {
    expect(buildRowCopyText('scalar', ['a'])).toBe('NULL')
  })
})

describe('buildRowsCopyText', () => {
  it('joins rows with newlines', () => {
    const rows = [{ a: 1 }, { a: 2 }]
    expect(buildRowsCopyText(rows, ['a'])).toBe('1\n2')
  })

  it('returns an empty string for no rows', () => {
    expect(buildRowsCopyText([], ['a'])).toBe('')
  })
})
