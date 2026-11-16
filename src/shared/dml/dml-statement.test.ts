import { describe, expect, it } from 'vitest'
import {
  detectDmlStatement,
  dmlMatchesQuery,
  parseDmlStatement,
  translateDmlStatement,
  translateRetry,
  type DmlAssignment
} from './dml-statement'

describe('DML Statement detection', () => {
  it.each([
    ['DELETE FROM c WHERE c.x = 1', 'DELETE'],
    ['delete from c where true', 'DELETE'],
    ['  UPDATE c SET c.a = 1 WHERE true', 'UPDATE'],
    ['-- tidy up\nDELETE FROM c WHERE true', 'DELETE'],
    ['/* bulk */ update c set c.a = 1 where true', 'UPDATE'],
    ['/* a */ -- b\n /* c */ Update c SET c.a = 1 WHERE true', 'UPDATE'],
    ['DELETE', 'DELETE']
  ])('treats %j as a DML Statement', (text, verb) => {
    expect(detectDmlStatement(text)).toBe(verb)
  })

  it.each([
    'SELECT * FROM c',
    'SELECT * FROM c WHERE c.op = "DELETE"',
    '-- DELETE FROM c WHERE true\nSELECT * FROM c',
    '/* UPDATE c SET c.a = 1 */ SELECT VALUE COUNT(1) FROM c',
    'DELETED',
    'UPDATES',
    '',
    '   ',
    '(DELETE)'
  ])('runs %j as a query, unchanged', (text) => {
    expect(detectDmlStatement(text)).toBeUndefined()
  })
})

describe('parsing a DELETE DML Statement', () => {
  it.each([
    ['DELETE FROM c WHERE c.status = "stale"', 'c', 'c.status = "stale"'],
    ['delete from doc where doc.n > 5;', 'doc', 'doc.n > 5'],
    ['DELETE FROM c WHERE true ;  ', 'c', 'true'],
    ['-- purge\nDELETE FROM c /* all */ WHERE c.n IN (1, 2)', 'c', 'c.n IN (1, 2)'],
    [
      'DELETE FROM c WHERE EXISTS(SELECT VALUE t FROM t IN c.tags WHERE t = "x")',
      'c',
      'EXISTS(SELECT VALUE t FROM t IN c.tags WHERE t = "x")'
    ],
    ["DELETE FROM c WHERE c.note = 'a;b -- not a comment'", 'c', "c.note = 'a;b -- not a comment'"],
    [
      'DELETE FROM c WHERE STARTSWITH(c.name, "x") AND ARRAY_LENGTH(c.items) > 0',
      'c',
      'STARTSWITH(c.name, "x") AND ARRAY_LENGTH(c.items) > 0'
    ]
  ])('accepts %j', (text, alias, condition) => {
    expect(parseDmlStatement(text)).toEqual({
      ok: true,
      statement: { verb: 'DELETE', alias, condition }
    })
  })
})

/** The SET assignments of an UPDATE QueryForge accepts. */
function assignmentsOf(text: string): DmlAssignment[] {
  const result = parseDmlStatement(text)
  if (!result.ok) throw new Error(result.error.message)
  if (result.statement.verb !== 'UPDATE') throw new Error('expected an UPDATE')
  return result.statement.assignments
}

describe('parsing an UPDATE DML Statement', () => {
  it('reads the alias, each SET assignment and the WHERE condition', () => {
    expect(
      parseDmlStatement('UPDATE c SET c.status = "archived", c.n = c.n + 1 WHERE c.n < 10;')
    ).toEqual({
      ok: true,
      statement: {
        verb: 'UPDATE',
        alias: 'c',
        assignments: [
          { kind: 'set', target: 'c.status', pointer: '/status', expression: '"archived"' },
          { kind: 'set', target: 'c.n', pointer: '/n', expression: 'c.n + 1' }
        ],
        condition: 'c.n < 10'
      }
    })
  })

  it.each([
    ['c.a.b', '/a/b'],
    ['c["odd key"]', '/odd key'],
    ["c['odd key'].x", '/odd key/x'],
    ['c.tags[0]', '/tags/0'],
    ['c.items[12].name', '/items/12/name'],
    ['c["a/b"]["t~1"]', '/a~1b/t~01'],
    ['c["say \\"hi\\""]', '/say "hi"'],
    ['c . spaced [ 3 ]', '/spaced/3'],
    ['c.select', '/select']
  ])('translates the SET target %s to the patch JSON pointer %s', (target, pointer) => {
    expect(assignmentsOf(`UPDATE c SET ${target} = 1 WHERE true`)).toEqual([
      { kind: 'set', target, pointer, expression: '1' }
    ])
  })

  it('passes SET expressions through verbatim, including functions, objects and subqueries', () => {
    const expressions = [
      'CONCAT(c.first, " ", c.last)',
      '{"a": 1, "b": [1, 2]}',
      '[c.x, c.y]',
      '(SELECT VALUE COUNT(1) FROM t IN c.tags WHERE t != "x")',
      'c.n >= 1 ? "big, really" : "small"'
    ]
    const sets = expressions.map((e, i) => `c.f${i} = ${e}`).join(', ')
    const assignments = assignmentsOf(`UPDATE c SET ${sets} WHERE true`)
    expect(assignments.map((a) => a.kind === 'set' && a.expression)).toEqual(expressions)
  })

  it('treats the literal undefined as a remove', () => {
    expect(assignmentsOf('UPDATE c SET c.legacy = undefined, c.n = 0 WHERE true')).toEqual([
      { kind: 'remove', target: 'c.legacy', pointer: '/legacy' },
      { kind: 'set', target: 'c.n', pointer: '/n', expression: '0' }
    ])
  })

  it('accepts exactly 10 assignments', () => {
    const sets = Array.from({ length: 10 }, (_, i) => `c.f${i} = ${i}`).join(', ')
    expect(parseDmlStatement(`UPDATE c SET ${sets} WHERE true`).ok).toBe(true)
  })
})

/** The named error a refused DML Statement comes back with. */
function syntaxError(text: string, partitionKeyPaths?: readonly string[]): string {
  const result = parseDmlStatement(text, partitionKeyPaths)
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`)
  return result.error.message
}

describe('refusing a DML Statement before anything is sent', () => {
  it.each([
    ['DELETE FROM c WHERE true; DELETE FROM c WHERE true', 'one statement'],
    ['DELETE FROM c WHERE true;;', 'one statement'],
    ['UPDATE c SET c.a = 1 WHERE true; SELECT * FROM c', 'one statement']
  ])('refuses %j as more than one statement', (text, expected) => {
    expect(syntaxError(text)).toContain(expected)
  })

  it.each([
    'DELETE FROM c',
    'DELETE FROM c;',
    'UPDATE c SET c.a = 1',
    'DELETE FROM c WHERE',
    'DELETE FROM c WHERE ;',
    'UPDATE c SET c.a = 1 WHERE   '
  ])('requires WHERE in %j', (text) => {
    expect(syntaxError(text)).toContain('WHERE true')
  })

  it.each([
    ['DELETE FROM c JOIN t IN c.tags WHERE t = "x"', 'JOIN'],
    ['UPDATE c JOIN t IN c.tags SET c.a = 1 WHERE true', 'JOIN'],
    ['DELETE FROM c WHERE c.n > 1 GROUP BY c.n', 'GROUP BY'],
    ['DELETE DISTINCT FROM c WHERE true', 'DISTINCT'],
    ['DELETE FROM c WHERE true ORDER BY c._ts', 'ORDER BY'],
    ['DELETE FROM c WHERE true OFFSET 0 LIMIT 10', 'OFFSET … LIMIT'],
    ['UPDATE c SET c.a = 1 WHERE true LIMIT 10', 'OFFSET … LIMIT'],
    ['DELETE TOP 10 FROM c WHERE true', 'TOP'],
    ['UPDATE TOP 10 c SET c.a = 1 WHERE true', 'TOP']
  ])('refuses %j naming %s', (text, clause) => {
    expect(syntaxError(text)).toContain(`${clause} is not supported in a DML Statement`)
  })

  it.each([
    'DELETE FROM c WHERE c.top = 1 AND c.order = 2 AND c["limit"] = 3',
    'DELETE FROM c WHERE c.id IN (SELECT VALUE TOP 1 x FROM x IN c.items ORDER BY x)',
    'DELETE FROM c WHERE ARRAY_CONTAINS((SELECT DISTINCT VALUE t FROM t IN c.tags), "x")',
    'DELETE FROM c WHERE c.note = "GROUP BY and JOIN are just words here"'
  ])('lets clause names through inside property names, strings and subqueries in %j', (text) => {
    expect(parseDmlStatement(text).ok).toBe(true)
  })

  it.each([
    ['DELETE c WHERE true', 'Expected FROM after DELETE'],
    ['DELETE FROM WHERE true', 'Expected an alias'],
    ['DELETE FROM c IN c.items WHERE true', 'Expected WHERE'],
    ['DELETE FROM root c WHERE true', 'Expected WHERE']
  ])('refuses the malformed shell %j', (text, expected) => {
    expect(syntaxError(text)).toContain(expected)
  })

  it.each([
    ['UPDATE SET c.a = 1 WHERE true', 'Expected an alias after UPDATE'],
    ['UPDATE c c.a = 1 WHERE true', 'Expected SET after UPDATE c'],
    ['UPDATE c SET WHERE true', 'SET needs at least one assignment'],
    ['UPDATE c SET c.a = 1, WHERE true', 'empty assignment'],
    ['UPDATE c SET c.a WHERE true', 'Expected "=" after c.a'],
    ['UPDATE c SET = 1 WHERE true', 'needs a target path'],
    ['UPDATE c SET c.a = WHERE true', 'needs a value'],
    ['UPDATE c SET d.a = 1 WHERE true', 'must start with the alias c'],
    ['UPDATE c SET c = 1 WHERE true', 'must name a property'],
    ['UPDATE c SET c.a[-1] = 1 WHERE true', 'not a valid SET target'],
    ['UPDATE c SET c.a[1.5] = 1 WHERE true', 'not a valid SET target'],
    ['UPDATE c SET c.a[c.i] = 1 WHERE true', 'not a valid SET target'],
    ['UPDATE c SET UPPER(c.a) = 1 WHERE true', 'not a valid SET target'],
    ['UPDATE c SET c.a + 1 = 1 WHERE true', 'not a valid SET target']
  ])('refuses the malformed UPDATE %j', (text, expected) => {
    expect(syntaxError(text)).toContain(expected)
  })

  it('refuses more than 10 assignments, the patch limit', () => {
    const sets = Array.from({ length: 11 }, (_, i) => `c.f${i} = ${i}`).join(', ')
    expect(syntaxError(`UPDATE c SET ${sets} WHERE true`)).toContain('at most 10')
  })

  it.each([
    'c.id',
    'c["id"]',
    'c.id.x',
    'c._rid',
    'c._self',
    'c._etag',
    'c._ts',
    'c._attachments',
    'c._ts.x'
  ])('refuses SET on the address or a system property: %s', (target) => {
    expect(syntaxError(`UPDATE c SET ${target} = 1 WHERE true`)).toContain(
      `SET ${target} is not allowed`
    )
  })

  it.each([
    [['/tenant'], 'c.tenant'],
    [['/tenant'], 'c.tenant.x'],
    [['/address/zip'], 'c.address.zip'],
    [['/address/zip'], 'c.address'],
    [['/tenant', '/region'], 'c.region'],
    [['/tenant', '/region', '/site'], 'c["site"]']
  ])('refuses SET on a partition key path (%j): %s', (partitionKeyPaths, target) => {
    expect(syntaxError(`UPDATE c SET ${target} = 1 WHERE true`, partitionKeyPaths)).toContain(
      `SET ${target} is not allowed`
    )
  })

  it('allows SET beside a partition key path', () => {
    const text = 'UPDATE c SET c.address.city = "x" WHERE true'
    expect(parseDmlStatement(text, ['/address/zip']).ok).toBe(true)
  })
})

/** The translation of a statement QueryForge accepts. */
function translated(text: string, partitionKeyPaths: readonly string[]) {
  const result = translateDmlStatement(text, partitionKeyPaths)
  if (!result.ok) throw new Error(result.error.message)
  return result.translation
}

describe('translating a DML Statement into its Driving Query', () => {
  it('projects the address and version, and no SET columns, for a DELETE', () => {
    expect(translated('DELETE FROM c WHERE c.n > 5;', ['/tenant'])).toEqual({
      drivingQuery: {
        query:
          'SELECT c.id, c._etag, c._rid, c.tenant AS __pkv1, IS_DEFINED(c.tenant) AS __pk1 ' +
          'FROM c WHERE c.n > 5',
        parameters: []
      },
      partitionKey: [{ path: '/tenant', valueColumn: '__pkv1', definedColumn: '__pk1' }],
      operations: []
    })
  })

  it('projects every level of a hierarchical partition key, with nested and quoted paths', () => {
    const { drivingQuery, partitionKey } = translated('DELETE FROM d WHERE true', [
      '/tenant',
      '/address/zip',
      '/"odd key"'
    ])
    expect(drivingQuery.query).toBe(
      'SELECT d.id, d._etag, d._rid, ' +
        'd.tenant AS __pkv1, IS_DEFINED(d.tenant) AS __pk1, ' +
        'd.address.zip AS __pkv2, IS_DEFINED(d.address.zip) AS __pk2, ' +
        'd["odd key"] AS __pkv3, IS_DEFINED(d["odd key"]) AS __pk3 ' +
        'FROM d WHERE true'
    )
    expect(partitionKey).toEqual([
      { path: '/tenant', valueColumn: '__pkv1', definedColumn: '__pk1' },
      { path: '/address/zip', valueColumn: '__pkv2', definedColumn: '__pk2' },
      { path: '/"odd key"', valueColumn: '__pkv3', definedColumn: '__pk3' }
    ])
  })

  it('projects each SET value, whether its path is defined and its current value for an UPDATE', () => {
    expect(
      translated(
        'UPDATE c SET c.n = c.n + 1, c.legacy = undefined, c["a b"][0] = UPPER(c.x) WHERE c.n < 10',
        ['/pk']
      )
    ).toEqual({
      drivingQuery: {
        query:
          'SELECT c.id, c._etag, c._rid, c.pk AS __pkv1, IS_DEFINED(c.pk) AS __pk1, ' +
          '(c.n + 1) AS __set1, IS_DEFINED(c.n) AS __def1, c.n AS __cur1, ' +
          'IS_DEFINED(c.legacy) AS __def2, c.legacy AS __cur2, ' +
          '(UPPER(c.x)) AS __set3, IS_DEFINED(c["a b"][0]) AS __def3, c["a b"][0] AS __cur3 ' +
          'FROM c WHERE c.n < 10',
        parameters: []
      },
      partitionKey: [{ path: '/pk', valueColumn: '__pkv1', definedColumn: '__pk1' }],
      operations: [
        {
          op: 'set',
          path: '/n',
          target: 'c.n',
          valueColumn: '__set1',
          definedColumn: '__def1',
          currentColumn: '__cur1'
        },
        {
          op: 'remove',
          path: '/legacy',
          target: 'c.legacy',
          definedColumn: '__def2',
          currentColumn: '__cur2'
        },
        {
          op: 'set',
          path: '/a b/0',
          target: 'c["a b"][0]',
          valueColumn: '__set3',
          definedColumn: '__def3',
          currentColumn: '__cur3'
        }
      ]
    })
  })

  it('refuses SET on a partition key path it was given', () => {
    const text = 'UPDATE c SET c.region = "eu" WHERE true'
    const result = translateDmlStatement(text, ['/tenant', '/region'])
    expect(result.ok ? undefined : result.error.message).toContain('partition key path /region')
  })

  it('refuses a malformed statement with the same named error the editor shows', () => {
    const text = 'DELETE FROM c WHERE true ORDER BY c._ts'
    const refusal = translateDmlStatement(text, ['/pk'])
    const parsed = parseDmlStatement(text)
    expect(refusal.ok ? undefined : refusal.error.message).toBe(
      parsed.ok ? 'parsed' : parsed.error.message
    )
  })
})

describe('opening the matches of a DML Statement as a query', () => {
  it.each([
    ['DELETE FROM c WHERE c.status = "stale"', 'SELECT * FROM c WHERE c.status = "stale"'],
    [
      'UPDATE c SET c.n = c.n + 1, c.old = undefined WHERE c.n < 5;',
      'SELECT * FROM c WHERE c.n < 5'
    ],
    ['delete from x where x.a IN (1, 2)', 'SELECT * FROM x WHERE x.a IN (1, 2)'],
    [
      '-- tidy\nDELETE FROM c WHERE EXISTS(SELECT VALUE t FROM t IN c.tags WHERE t = "x")',
      'SELECT * FROM c WHERE EXISTS(SELECT VALUE t FROM t IN c.tags WHERE t = "x")'
    ]
  ])('selects every document %j would write', (statement, query) => {
    expect(dmlMatchesQuery(statement)).toBe(query)
  })

  it('has no matches query for a malformed DML Statement', () => {
    expect(dmlMatchesQuery('DELETE FROM c')).toBeUndefined()
  })
})

describe('scoping a Retry Driving Query to the documents not written', () => {
  it('re-checks the WHERE only for the given addresses, one generated parameter per value', () => {
    const result = translateRetry('DELETE FROM c WHERE c.status = "stale" OR c.old', ['/customerId'], [
      { id: 'a', partitionKey: 'x' },
      { id: 'b', partitionKey: 'y' },
      { id: 'a', partitionKey: 'y' }
    ])

    expect(result.ok && result.chunks).toEqual([
      {
        drivingQuery: {
          query:
            'SELECT c.id, c._etag, c._rid, c.customerId AS __pkv1, IS_DEFINED(c.customerId) AS __pk1 ' +
            'FROM c WHERE (c.status = "stale" OR c.old) AND c.id IN (@id1, @id2) ' +
            'AND c.customerId IN (@pk1_1, @pk1_2)',
          parameters: [
            { name: '@id1', value: 'a' },
            { name: '@id2', value: 'b' },
            { name: '@pk1_1', value: 'x' },
            { name: '@pk1_2', value: 'y' }
          ]
        },
        addresses: [
          { id: 'a', partitionKey: 'x' },
          { id: 'b', partitionKey: 'y' },
          { id: 'a', partitionKey: 'y' }
        ]
      }
    ])
  })

  it('matches the None value of a hierarchical partition key level with NOT IS_DEFINED', () => {
    const result = translateRetry(
      'UPDATE c SET c.n = c.n + 1 WHERE c.n < 5',
      ['/tenant', '/address/region'],
      [
        { id: 'a', partitionKey: ['t1', {}] },
        { id: 'b', partitionKey: ['t1', null] },
        { id: 'c', partitionKey: [{}, {}] }
      ]
    )

    const [chunk] = result.ok ? result.chunks : []
    expect(chunk.drivingQuery.query).toContain(
      'WHERE (c.n < 5) AND c.id IN (@id1, @id2, @id3) ' +
        'AND (NOT IS_DEFINED(c.tenant) OR c.tenant IN (@pk1_1)) ' +
        'AND (NOT IS_DEFINED(c.address.region) OR c.address.region IN (@pk2_1))'
    )
    expect(chunk.drivingQuery.query).toContain('(c.n + 1) AS __set1')
    expect(chunk.drivingQuery.parameters).toEqual([
      { name: '@id1', value: 'a' },
      { name: '@id2', value: 'b' },
      { name: '@id3', value: 'c' },
      { name: '@pk1_1', value: 't1' },
      { name: '@pk2_1', value: null }
    ])
  })

  it('needs no IN list for a partition key level that is None for every address', () => {
    const result = translateRetry('DELETE FROM c WHERE true', ['/pk'], [{ id: 'a', partitionKey: {} }])

    const [chunk] = result.ok ? result.chunks : []
    expect(chunk.drivingQuery.query).toMatch(/WHERE \(true\) AND c\.id IN \(@id1\) AND NOT IS_DEFINED\(c\.pk\)$/)
    expect(chunk.drivingQuery.parameters).toEqual([{ name: '@id1', value: 'a' }])
  })

  const addresses = (count: number, idLength = 4): Array<{ id: string; partitionKey: string }> =>
    Array.from({ length: count }, (_, i) => ({
      id: String(i).padStart(idLength, '0'),
      partitionKey: `p${i % 7}`
    }))

  it('splits into chunks of at most 1,000 addresses, in order', () => {
    const all = addresses(2_345)

    const result = translateRetry('DELETE FROM c WHERE true', ['/pk'], all)

    const chunks = result.ok ? result.chunks : []
    expect(chunks.map((chunk) => chunk.addresses.length)).toEqual([1_000, 1_000, 345])
    expect(chunks.flatMap((chunk) => chunk.addresses)).toEqual(all)
    expect(chunks[1].drivingQuery.parameters[0]).toEqual({ name: '@id1', value: '1000' })
    expect(chunks[1].drivingQuery.parameters.filter((p) => p.name.startsWith('@id'))).toHaveLength(1_000)
  })

  it('splits further so no chunk holds more than 256 KB of addresses', () => {
    // About 1 KB per address, so 256 KB is reached well before 1,000.
    const all = addresses(600, 1_000)

    const result = translateRetry('DELETE FROM c WHERE true', ['/pk'], all)

    const chunks = result.ok ? result.chunks : []
    expect(chunks.length).toBe(3)
    for (const chunk of chunks) {
      const bytes = chunk.addresses.reduce((sum, a) => sum + a.id.length + String(a.partitionKey).length, 0)
      expect(bytes).toBeLessThanOrEqual(256 * 1024)
    }
    // Full chunks until the last: 256 KB holds about 260 such addresses.
    expect(chunks[0].addresses.length).toBeGreaterThan(250)
    expect(chunks[1].addresses.length).toBeGreaterThan(250)
    expect(chunks.flatMap((chunk) => chunk.addresses)).toEqual(all)
  })

  it('has no chunks when there is nothing to retry', () => {
    const result = translateRetry('DELETE FROM c WHERE true', ['/pk'], [])
    expect(result.ok && result.chunks).toEqual([])
  })

  it('refuses a statement that no longer parses with its named error', () => {
    const result = translateRetry('DELETE FROM c', ['/pk'], addresses(1))
    expect(result.ok ? undefined : result.error.message).toContain('WHERE is required')
  })
})
