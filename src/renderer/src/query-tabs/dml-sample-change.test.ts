import { describe, expect, it } from 'vitest'
import type { DmlSampleChange, DmlSampleValue } from '@shared/types/dml-run'
import { arrayChangeSummary, arrayEdit, sampleChangeDiff, sampleValueText } from './dml-sample-change'

const v = (value: unknown): DmlSampleValue => ({ defined: true, value })
const absent: DmlSampleValue = { defined: false }
const change = (current: DmlSampleValue, next: DmlSampleValue): DmlSampleChange => ({
  target: 'c.statusHistory',
  current,
  next
})

const received = { status: 'RECEIVED', userId: 'SYSTEM' }
const created = { status: 'CREATE_ORDER', userId: 'SYSTEM' }
const canceled = { status: 'CANCELED', userId: 'SYSTEM' }

describe('sampleValueText', () => {
  it('shows an absent value and truncates long JSON', () => {
    expect(sampleValueText(absent)).toBe('(absent)')
    expect(sampleValueText(v(null))).toBe('null')
    const text = sampleValueText(v('x'.repeat(100)))
    expect(text).toHaveLength(60)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('arrayEdit', () => {
  it('finds an append, a prepend and a middle replacement', () => {
    expect(arrayEdit([received, created], [received, created, canceled])).toEqual({
      kept: 2,
      removed: [],
      added: [canceled]
    })
    expect(arrayEdit([created], [received, created])).toEqual({ kept: 1, removed: [], added: [received] })
    expect(arrayEdit([received, created, canceled], [received, canceled])).toEqual({
      kept: 2,
      removed: [created],
      added: []
    })
  })

  it('compares entries by value', () => {
    expect(arrayEdit([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toEqual({ kept: 1, removed: [], added: [{ a: 2 }] })
  })
})

describe('arrayChangeSummary', () => {
  it('summarises appending one entry with the entry itself', () => {
    expect(arrayChangeSummary(change(v([received, created]), v([received, created, canceled])))).toEqual({
      kept: '2 entries',
      delta: '+ {"status":"CANCELED","userId":"SYSTEM"}'
    })
  })

  it('counts several added or removed entries', () => {
    expect(arrayChangeSummary(change(v([received]), v([received, created, canceled])))).toEqual({
      kept: '1 entry',
      delta: '+ 2 entries'
    })
    expect(arrayChangeSummary(change(v([received, created, canceled]), v([received])))).toEqual({
      kept: '1 entry',
      delta: '− 2 entries'
    })
  })

  it('appends to an empty array', () => {
    expect(arrayChangeSummary(change(v([]), v([canceled])))?.kept).toBe('0 entries')
  })

  it('has no summary for non-arrays, unchanged arrays or mixed edits', () => {
    expect(arrayChangeSummary(change(v('CREATE_ORDER'), v('CANCELED')))).toBeUndefined()
    expect(arrayChangeSummary(change(absent, v([canceled])))).toBeUndefined()
    expect(arrayChangeSummary(change(v([received]), v([received])))).toBeUndefined()
    expect(arrayChangeSummary(change(v([received, created]), v([received, canceled])))).toBeUndefined()
  })
})

describe('sampleChangeDiff', () => {
  it('marks only the appended entry as added', () => {
    const lines = sampleChangeDiff(change(v([received]), v([received, canceled])))
    expect(lines.filter((line) => line.kind === 'removed')).toEqual([])
    expect(lines.filter((line) => line.kind === 'added').map((line) => line.text)).toEqual([
      '  },',
      '  {',
      '    "status": "CANCELED",',
      '    "userId": "SYSTEM"'
    ])
    expect(lines.filter((line) => line.kind === 'same')).toHaveLength(6)
  })

  it('diffs a scalar and an absent value', () => {
    expect(sampleChangeDiff(change(v('CREATE_ORDER'), v('CANCELED')))).toEqual([
      { kind: 'removed', text: '"CREATE_ORDER"' },
      { kind: 'added', text: '"CANCELED"' }
    ])
    expect(sampleChangeDiff(change(v(1), absent))).toEqual([
      { kind: 'removed', text: '1' },
      { kind: 'added', text: '(absent)' }
    ])
  })
})
