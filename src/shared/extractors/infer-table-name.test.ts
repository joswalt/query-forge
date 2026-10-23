import { describe, expect, it } from 'vitest'
import { inferTableName } from './infer-table-name'

describe('inferTableName', () => {
  it('reads a single-table FROM', () => {
    expect(inferTableName('SELECT * FROM Users')).toBe('Users')
    expect(inferTableName('select id\nfrom   orders\nwhere id = 1')).toBe('orders')
  })

  it('keeps schema-qualified and bracketed names as written', () => {
    expect(inferTableName('SELECT * FROM dbo.Users WHERE x = 1')).toBe('dbo.Users')
    expect(inferTableName('SELECT * FROM [dbo].[Order Details] od')).toBe('[dbo].[Order Details]')
  })

  it('ignores an alias', () => {
    expect(inferTableName('SELECT u.id FROM Users AS u WHERE u.id = 1')).toBe('Users')
    expect(inferTableName('SELECT TOP 10 * FROM Users u ORDER BY u.id')).toBe('Users')
  })

  it('reads the container identifier of a Cosmos query', () => {
    expect(inferTableName('SELECT c.id FROM products c WHERE c.type = "x"')).toBe('products')
  })

  it('ignores FROM inside strings and comments', () => {
    expect(inferTableName("SELECT 'from x' AS s FROM t -- from y\n/* from z */")).toBe('t')
  })

  it('gives up on joins, comma joins, subqueries and table-valued functions', () => {
    expect(inferTableName('SELECT * FROM a JOIN b ON a.id = b.id')).toBeUndefined()
    expect(inferTableName('SELECT * FROM a, b')).toBeUndefined()
    expect(inferTableName('SELECT * FROM a x, b y')).toBeUndefined()
    expect(inferTableName('SELECT * FROM (SELECT 1 AS n) q')).toBeUndefined()
    expect(inferTableName('SELECT * FROM a WHERE id IN (SELECT id FROM b)')).toBeUndefined()
    expect(inferTableName('SELECT * FROM dbo.fn(1)')).toBeUndefined()
    expect(inferTableName('SELECT VALUE t FROM c JOIN t IN c.tags')).toBeUndefined()
    expect(inferTableName('SELECT * FROM a CROSS APPLY dbo.fn(a.id)')).toBeUndefined()
  })

  it('gives up on a multi-statement script and on no FROM at all', () => {
    expect(inferTableName('SELECT * FROM a; SELECT * FROM b')).toBeUndefined()
    expect(inferTableName('SELECT 1')).toBeUndefined()
    expect(inferTableName('')).toBeUndefined()
  })
})
