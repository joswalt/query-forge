import { describe, expect, it } from 'vitest'
import { formatQuery } from './format-query'

describe('formatQuery', () => {
  it('puts T-SQL clauses on their own lines with upper-case keywords', () => {
    const out = formatQuery('select a,b from dbo.t where a=1 order by b', 'azure-sql')
    expect(out).toBe(['SELECT', '  a,', '  b', 'FROM', '  dbo.t', 'WHERE', '  a = 1', 'ORDER BY', '  b'].join('\n'))
  })

  it('keeps Cosmos constructs intact', () => {
    const out = formatQuery(
      'select value c.id from c join t in c.tags where c["my key"] = @p and t = "x"',
      'cosmos-db'
    )
    expect(out).toMatch(/SELECT\s+value c\.id/)
    expect(out).toContain('JOIN t IN c.tags')
    expect(out).toContain('FROM\n  c')
    expect(out).toContain('c["my key"]')
    expect(out).toContain('@p')
    expect(out).toContain('"x"')
  })

  it('never changes the case of Cosmos property paths (they are case-sensitive)', () => {
    const out = formatQuery(
      'select top 100 c.order, c.value, c.date, c.Type, c.Name from c where c.Status = "Active" order by c.Order',
      'cosmos-db'
    )
    for (const path of ['c.order', 'c.value', 'c.date', 'c.Type', 'c.Name', 'c.Status', 'c.Order', '"Active"']) {
      expect(out).toContain(path)
    }
  })

  it('formats the Object Explorer default Cosmos query', () => {
    expect(formatQuery('SELECT TOP 100 * FROM c', 'cosmos-db')).toBe('SELECT\n  TOP 100 *\nFROM\n  c')
  })

  it('returns input unchanged when it cannot be parsed', () => {
    const broken = "select 'unterminated"
    expect(formatQuery(broken, 'azure-sql')).toBe(broken)
  })

  it('is idempotent', () => {
    const once = formatQuery('select a from t where b = 2', 'azure-sql')
    expect(formatQuery(once, 'azure-sql')).toBe(once)
  })
})
