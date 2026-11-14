import { describe, expect, it } from 'vitest'
import { addressOf, isOutOfDate, notAddressableReason, sameAddress } from './addressable-row'

/** The system properties that make a row a full document, not a projection. */
const system = { _rid: 'rid-1', _self: 'dbs/x/colls/y/docs/rid-1', _etag: '"e1"', _ts: 1_700_000_000 }

describe('addressOf', () => {
  it('treats a projection with id and the partition key value as an Addressable Row', () => {
    expect(addressOf({ id: 'a1', customerId: 'c9', name: 'Ada' }, ['/customerId'])).toEqual({
      addressable: true,
      address: { id: 'a1', partitionKey: 'c9' }
    })
  })

  it('treats a projection without the partition key value as not addressable, naming it', () => {
    expect(addressOf({ id: 'a1', name: 'Ada' }, ['/customerId'])).toEqual({
      addressable: false,
      missing: ['customerId']
    })
  })

  it('treats a JSON null partition key value as known, addressing the null partition', () => {
    expect(addressOf({ id: 'a1', customerId: null }, ['/customerId'])).toEqual({
      addressable: true,
      address: { id: 'a1', partitionKey: null }
    })
  })

  it('treats a missing partition key property on a full document as the None value', () => {
    expect(addressOf({ id: 'a1', ...system }, ['/customerId'])).toEqual({
      addressable: true,
      address: { id: 'a1', partitionKey: {} }
    })
  })

  it('needs every system property before a missing value counts as None', () => {
    const { _ts: _omitted, ...partial } = system
    expect(addressOf({ id: 'a1', ...partial }, ['/customerId'])).toEqual({
      addressable: false,
      missing: ['customerId']
    })
  })

  it('reads a nested partition key path', () => {
    expect(addressOf({ id: 'a1', address: { zip: '72716' } }, ['/address/zip'])).toEqual({
      addressable: true,
      address: { id: 'a1', partitionKey: '72716' }
    })
  })

  it('addresses a hierarchical partition key with one value per level', () => {
    expect(
      addressOf({ id: 'a1', tenant: 't1', region: 'us', ...system }, ['/tenant', '/region', '/zone'])
    ).toEqual({ addressable: true, address: { id: 'a1', partitionKey: ['t1', 'us', {}] } })
  })

  it('applies the projection rule per level of a hierarchical key', () => {
    expect(addressOf({ id: 'a1', tenant: 't1', zone: null }, ['/tenant', '/region', '/zone'])).toEqual({
      addressable: false,
      missing: ['region']
    })
  })

  it.each([
    ['a SELECT VALUE scalar', 42],
    ['a SELECT VALUE string', 'Ada'],
    ['an array row', ['a1', 'c9']],
    ['null', null]
  ])('never treats %s as addressable', (_label, row) => {
    expect(addressOf(row, ['/customerId'])).toEqual({ addressable: false, missing: [] })
  })

  it('needs a string id', () => {
    expect(addressOf({ id: 7, customerId: 'c9' }, ['/customerId'])).toEqual({
      addressable: false,
      missing: ['id']
    })
    expect(addressOf({ customerId: 'c9', ...system }, ['/customerId'])).toEqual({
      addressable: false,
      missing: ['id']
    })
  })

  it('treats an object or array partition key value as unknown', () => {
    expect(addressOf({ id: 'a1', customerId: { nested: 1 } }, ['/customerId'])).toEqual({
      addressable: false,
      missing: ['customerId']
    })
  })

  it('treats every row as not addressable when the partition key paths are absent', () => {
    expect(addressOf({ id: 'a1', customerId: 'c9', ...system }, undefined)).toEqual({
      addressable: false,
      missing: []
    })
  })
})

describe('notAddressableReason', () => {
  it('names the missing fields and every field an Addressable Row needs', () => {
    expect(notAddressableReason(['/customerId'], ['customerId'])).toBe(
      'This row has no customerId. Only rows with id and customerId can be edited. Re-run with SELECT * (or include them) to edit.'
    )
  })

  it('lists hierarchical partition key fields', () => {
    expect(notAddressableReason(['/tenant', '/address/region'], ['id', 'address.region'])).toBe(
      'This row has no id and address.region. Only rows with id, tenant and address.region can be edited. Re-run with SELECT * (or include them) to edit.'
    )
  })

  it('explains a row that is not a JSON object without naming missing fields', () => {
    expect(notAddressableReason(['/customerId'], [])).toBe(
      'Only rows with id and customerId can be edited. Re-run with SELECT * (or include them) to edit.'
    )
  })

  it('explains that rows cannot be edited when the partition key paths are unknown', () => {
    expect(notAddressableReason(undefined, [])).toContain("doesn't know this container's partition key")
  })
})

describe('sameAddress', () => {
  it('compares partition key values structurally, telling null, None and strings apart', () => {
    expect(sameAddress({ id: 'a', partitionKey: ['t', {}] }, { id: 'a', partitionKey: ['t', {}] })).toBe(true)
    expect(sameAddress({ id: 'a', partitionKey: null }, { id: 'a', partitionKey: {} })).toBe(false)
    expect(sameAddress({ id: 'a', partitionKey: 1 }, { id: 'a', partitionKey: '1' })).toBe(false)
    expect(sameAddress({ id: 'a', partitionKey: 'c' }, { id: 'b', partitionKey: 'c' })).toBe(false)
  })
})

describe('isOutOfDate', () => {
  it('flags a row whose _rid differs from the server copy (deleted and recreated)', () => {
    expect(isOutOfDate({ id: 'a1', _rid: 'old' }, { id: 'a1', _rid: 'new' })).toBe(true)
  })

  it('accepts a row with the same _rid, or a projection without one', () => {
    expect(isOutOfDate({ id: 'a1', _rid: 'r1' }, { id: 'a1', _rid: 'r1' })).toBe(false)
    expect(isOutOfDate({ id: 'a1', customerId: 'c9' }, { id: 'a1', _rid: 'r1' })).toBe(false)
  })
})
