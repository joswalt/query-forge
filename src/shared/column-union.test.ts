import { describe, expect, it } from 'vitest'
import { computeColumnUnion } from './column-union'

describe('computeColumnUnion', () => {
  it('returns an empty array for no rows', () => {
    expect(computeColumnUnion([])).toEqual([])
  })

  it('returns a single row’s keys in declaration order', () => {
    expect(computeColumnUnion([{ b: 1, a: 2 }])).toEqual(['b', 'a'])
  })

  it('unions keys across heterogeneous rows, first-seen order', () => {
    const rows = [{ id: '1', name: 'a' }, { id: '2', extra: true }, { id: '3', name: 'c', extra: false }]
    expect(computeColumnUnion(rows)).toEqual(['id', 'name', 'extra'])
  })

  it('does not duplicate a key seen on multiple rows', () => {
    const rows = [{ id: '1' }, { id: '2' }]
    expect(computeColumnUnion(rows)).toEqual(['id'])
  })

  it('ignores non-object rows (e.g. a scalar result) without throwing', () => {
    expect(computeColumnUnion([1, 'two', null, { a: 1 }])).toEqual(['a'])
  })

  it('treats arrays as non-record rows (no numeric-index columns)', () => {
    expect(computeColumnUnion([[1, 2, 3], { a: 1 }])).toEqual(['a'])
  })
})
