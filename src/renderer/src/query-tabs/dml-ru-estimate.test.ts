import { describe, expect, it } from 'vitest'
import { emptyOutcomeCounts } from '@shared/types/dml-run'
import { projectedRequestCharge, writeRequestChargeBand } from './dml-ru-estimate'

describe('rough write-RU band at the DML confirmation', () => {
  it('a DELETE is anchored on about 5.5 RU per 1 KB per document', () => {
    expect(
      writeRequestChargeBand({ verb: 'DELETE', matchCount: 1840, averageDocumentSize: 2048 })
    ).toEqual({ low: 20_240, high: 80_960 })
  })

  it('an UPDATE patch costs about twice an insert', () => {
    expect(
      writeRequestChargeBand({ verb: 'UPDATE', matchCount: 1840, averageDocumentSize: 2048 })
    ).toEqual({ low: 40_480, high: 161_920 })
  })

  it('a document smaller than 1 KB still costs at least the 1 KB anchor', () => {
    expect(
      writeRequestChargeBand({ verb: 'DELETE', matchCount: 10, averageDocumentSize: 300 })
    ).toEqual({ low: 55, high: 220 })
  })

  it('has no band when the Driving Query returned no average document size', () => {
    expect(writeRequestChargeBand({ verb: 'DELETE', matchCount: 10 })).toBeUndefined()
  })
})

describe('projected total RU while a DML Plan is committed', () => {
  const progress = (completed: number, total: number, requestCharge: number) => ({
    completed,
    total,
    requestCharge,
    counts: { ...emptyOutcomeCounts(), written: completed }
  })

  it('has no projection until 8 writes have reported', () => {
    expect(
      projectedRequestCharge({ drivingQueryRequestCharge: 4.5, progress: progress(7, 100, 70) })
    ).toBeUndefined()
  })

  it('adds the remaining documents at the mean RU per write to the running total', () => {
    // Running total 4.5 + 80, then 92 more at 10 RU each.
    expect(
      projectedRequestCharge({ drivingQueryRequestCharge: 4.5, progress: progress(8, 100, 80) })
    ).toBe(1004.5)
  })

  it('follows the measured mean as more writes report', () => {
    // 50 writes at a mean of 12.5 RU: 2 + 625 + 50 × 12.5.
    expect(
      projectedRequestCharge({ drivingQueryRequestCharge: 2, progress: progress(50, 100, 625) })
    ).toBe(1252)
  })

  it('is the running total once every document has reported', () => {
    expect(
      projectedRequestCharge({ drivingQueryRequestCharge: 3, progress: progress(20, 20, 200) })
    ).toBe(203)
  })
})
