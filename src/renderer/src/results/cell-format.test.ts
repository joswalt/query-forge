import { describe, expect, it } from 'vitest'
import { formatCellValue } from './cell-format'

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
