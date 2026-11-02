import { describe, expect, it } from 'vitest'
import { FIT_MAX_WIDTH_PX, FIT_MIN_WIDTH_PX, fitColumnWidth } from './column-fit'

const sevenPxPerChar = (text: string): number => text.length * 7

function fit(header: string, values: unknown[]): number {
  return fitColumnWidth({
    header,
    values,
    measureHeader: sevenPxPerChar,
    measureCell: sevenPxPerChar,
    paddingPx: 20
  })
}

describe('fitColumnWidth', () => {
  it('fits the widest value plus padding', () => {
    expect(fit('city', ['Galva', '5135 Carolina Beach Rd', 'NC'])).toBe(22 * 7 + 20)
  })

  it('fits the header when it is wider than every value', () => {
    expect(fit('missingProviderFields', ['zip', null])).toBe(21 * 7 + 20)
  })

  it('measures null as its NULL text and objects as compact JSON', () => {
    expect(fit('a', [null])).toBe(FIT_MIN_WIDTH_PX)
    expect(fit('a', [{ addressLine1: 'x', city: 'y' }])).toBe(
      JSON.stringify({ addressLine1: 'x', city: 'y' }).length * 7 + 20
    )
  })

  it('caps very long values at the maximum width', () => {
    expect(fit('notes', ['x'.repeat(500)])).toBe(FIT_MAX_WIDTH_PX)
  })

  it('never goes below the minimum width', () => {
    expect(fit('', [])).toBe(FIT_MIN_WIDTH_PX)
  })

  it('finds the widest value among many rows', () => {
    const values = Array.from({ length: 10_000 }, (_, i) => `row-${i}`)
    values[7_321] = 'the one long value in the column'
    expect(fit('id', values)).toBe('the one long value in the column'.length * 7 + 20)
  })
})
