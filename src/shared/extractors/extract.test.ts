import { describe, expect, it } from 'vitest'
import { extract, EXTRACTORS, getExtractor, type ExtractorOptions } from './extract'

const withHeader: ExtractorOptions = { includeHeader: true, tableName: 'my_table' }
const noHeader: ExtractorOptions = { includeHeader: false, tableName: 'my_table' }

describe('Extractor registry', () => {
  it('falls back to CSV for an unknown Extractor id', () => {
    expect(getExtractor('nope').id).toBe('csv')
  })

  it('gives every Extractor a unique id', () => {
    const ids = EXTRACTORS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('CSV Extractor', () => {
  it('writes a header, then data rows in column order with missing fields empty', () => {
    const rows = [
      { id: '1', name: 'a' },
      { id: '2', extra: true }
    ]
    expect(extract('csv', rows, ['id', 'name', 'extra'], withHeader)).toBe(
      'id,name,extra\n1,a,\n2,,true'
    )
  })

  it('omits the header when Include header is off', () => {
    expect(extract('csv', [{ a: 1 }, { a: 2 }], ['a'], noHeader)).toBe('1\n2')
  })

  it('quotes values containing commas, quotes, or newlines (RFC 4180)', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2', d: 'l1\rl2' }]
    expect(extract('csv', rows, ['a', 'b', 'c', 'd'], noHeader)).toBe(
      '"x,y","say ""hi""","l1\nl2","l1\rl2"'
    )
  })

  it('renders null and missing values as empty fields, not "NULL"', () => {
    expect(extract('csv', [{ a: null }], ['a', 'b'], noHeader)).toBe(',')
  })

  it('renders nested objects and arrays as compact JSON', () => {
    expect(extract('csv', [{ a: { x: 1 }, b: [1, 2] }], ['a', 'b'], noHeader)).toBe(
      '"{""x"":1}","[1,2]"'
    )
  })

  it('keeps unicode text as-is', () => {
    expect(extract('csv', [{ a: 'café ☕' }], ['a'], noHeader)).toBe('café ☕')
  })

  it('treats a non-object row as all columns empty', () => {
    expect(extract('csv', ['scalar'], ['id'], noHeader)).toBe('')
  })

  it('writes only the header for no rows', () => {
    expect(extract('csv', [], ['a', 'b'], withHeader)).toBe('a,b')
  })
})

describe('JSON Extractor', () => {
  it('writes a valid JSON array preserving nested structure and heterogeneous rows', () => {
    const rows = [
      { id: 1, nested: { a: [1, 2] } },
      { id: 2, extra: true }
    ]
    const text = extract('json', rows, ['id'], withHeader)
    expect(JSON.parse(text)).toEqual(rows)
    expect(text).toBe('[\n{"id":1,"nested":{"a":[1,2]}},\n{"id":2,"extra":true}\n]')
  })

  it('still produces an array for a single row', () => {
    expect(JSON.parse(extract('json', [{ id: 1 }], ['id'], withHeader))).toEqual([{ id: 1 }])
  })

  it('writes an empty array for no rows', () => {
    expect(extract('json', [], [], withHeader)).toBe('[]')
  })
})

describe('TSV, Pipe-separated and Semicolon-separated Extractors', () => {
  const rows = [{ a: 'x', b: 2 }, { a: null }]

  it('joins values with their delimiter, header first', () => {
    expect(extract('tsv', rows, ['a', 'b'], withHeader)).toBe('a\tb\nx\t2\n\t')
    expect(extract('pipe', rows, ['a', 'b'], withHeader)).toBe('a|b\nx|2\n|')
    expect(extract('semicolon', rows, ['a', 'b'], withHeader)).toBe('a;b\nx;2\n;')
  })

  it('quotes values containing their own delimiter, quotes, or newlines only', () => {
    const tricky = [{ a: 'has\ttab', b: 'a,b', c: 'p|q', d: 's;t', e: 'say "hi"', f: 'l1\nl2' }]
    const columns = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(extract('tsv', tricky, columns, noHeader)).toBe(
      '"has\ttab"\ta,b\tp|q\ts;t\t"say ""hi"""\t"l1\nl2"'
    )
    expect(extract('pipe', tricky, columns, noHeader)).toBe(
      'has\ttab|a,b|"p|q"|s;t|"say ""hi"""|"l1\nl2"'
    )
    expect(extract('semicolon', tricky, columns, noHeader)).toBe(
      'has\ttab;a,b;p|q;"s;t";"say ""hi""";"l1\nl2"'
    )
  })

  it('renders nested values as compact JSON', () => {
    expect(extract('tsv', [{ a: { x: [1] } }], ['a'], noHeader)).toBe('"{""x"":[1]}"')
  })
})

describe('JSON Lines Extractor', () => {
  it('writes one compact document per line, preserving nested structure', () => {
    const rows = [{ id: 1, n: { a: [1] } }, { id: 2 }]
    expect(extract('jsonl', rows, ['id'], withHeader)).toBe('{"id":1,"n":{"a":[1]}}\n{"id":2}')
  })

  it('writes nothing for no rows', () => {
    expect(extract('jsonl', [], [], withHeader)).toBe('')
  })
})

describe('Markdown Extractor', () => {
  it('writes a header, divider and one table row per row', () => {
    const rows = [{ id: 1, name: 'a' }, { id: 2 }]
    expect(extract('markdown', rows, ['id', 'name'], withHeader)).toBe(
      '| id | name |\n| --- | --- |\n| 1 | a |\n| 2 |  |'
    )
  })

  it('omits the header and divider when Include header is off', () => {
    expect(extract('markdown', [{ id: 1 }], ['id'], noHeader)).toBe('| 1 |')
  })

  it('escapes | and renders embedded newlines as <br>', () => {
    expect(extract('markdown', [{ a: 'p|q', b: 'l1\nl2\r\nl3' }], ['a', 'b'], noHeader)).toBe(
      '| p\\|q | l1<br>l2<br>l3 |'
    )
  })

  it('escapes | in column names and renders nested values as compact JSON', () => {
    expect(extract('markdown', [{ 'a|b': { x: 1 } }], ['a|b'], withHeader)).toBe(
      '| a\\|b |\n| --- |\n| {"x":1} |'
    )
  })

  it('writes only the header for no rows, and nothing without columns', () => {
    expect(extract('markdown', [], ['a'], withHeader)).toBe('| a |\n| --- |')
    expect(extract('markdown', [], [], withHeader)).toBe('')
  })
})

describe('Pretty Extractor', () => {
  it('draws an ASCII box table with columns padded to the widest value', () => {
    const rows = [
      { id: 1, name: 'alice' },
      { id: 22, name: null }
    ]
    expect(extract('pretty', rows, ['id', 'name'], withHeader)).toBe(
      [
        '+----+-------+',
        '| id | name  |',
        '+----+-------+',
        '| 1  | alice |',
        '| 22 |       |',
        '+----+-------+'
      ].join('\n')
    )
  })

  it('omits the header row when Include header is off', () => {
    expect(extract('pretty', [{ id: 1 }], ['id'], noHeader)).toBe(
      ['+---+', '| 1 |', '+---+'].join('\n')
    )
  })

  it('caps a column at 60 characters with an ellipsis and shows newlines as ↵', () => {
    const long = 'x'.repeat(70)
    const text = extract('pretty', [{ a: long }, { a: 'l1\nl2' }], ['a'], noHeader)
    const lines = text.split('\n')
    expect(lines[1]).toBe(`| ${'x'.repeat(59)}… |`)
    expect(lines[2]).toBe(`| l1↵l2${' '.repeat(55)} |`)
  })

  it('draws just the header box for no rows, and nothing without columns', () => {
    expect(extract('pretty', [], ['ab'], withHeader)).toBe(
      ['+----+', '| ab |', '+----+'].join('\n')
    )
    expect(extract('pretty', [], [], withHeader)).toBe('')
  })
})

describe('One-row Extractor', () => {
  it('joins every value on one line, strings quoted, numbers bare', () => {
    expect(extract('one-row', [{ id: 1 }, { id: 2 }, { id: 3 }], ['id'], withHeader)).toBe(
      '1, 2, 3'
    )
    expect(extract('one-row', [{ s: "o'brien" }, { s: 'x' }], ['s'], withHeader)).toBe(
      "'o''brien', 'x'"
    )
  })

  it('walks rows then columns, rendering null as NULL and nested values as quoted JSON', () => {
    const rows = [
      { a: 1, b: null },
      { a: true, b: { x: 1 } }
    ]
    expect(extract('one-row', rows, ['a', 'b'], withHeader)).toBe(`1, NULL, true, '{"x":1}'`)
  })

  it('writes nothing for no rows', () => {
    expect(extract('one-row', [], ['a'], withHeader)).toBe('')
  })
})

describe('SQL Inserts Extractor', () => {
  const sql: ExtractorOptions = { includeHeader: true, tableName: 'dbo.Users' }

  it('writes one INSERT per row with bracketed columns into the Table field name', () => {
    const rows = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' }
    ]
    expect(extract('sql-inserts', rows, ['id', 'name'], sql)).toBe(
      "INSERT INTO dbo.Users ([id], [name]) VALUES (1, N'a');\n" +
        "INSERT INTO dbo.Users ([id], [name]) VALUES (2, N'b');"
    )
  })

  it('renders T-SQL literals: numbers bare, booleans 1/0, N-strings with doubled quotes, NULL', () => {
    const rows = [{ n: -1.5, big: 10n, t: true, f: false, s: "o'brien", z: null }]
    expect(extract('sql-inserts', rows, ['n', 'big', 't', 'f', 's', 'z', 'missing'], sql)).toBe(
      "INSERT INTO dbo.Users ([n], [big], [t], [f], [s], [z], [missing]) VALUES (-1.5, 10, 1, 0, N'o''brien', NULL, NULL);"
    )
  })

  it('renders nested values as JSON string literals and dates as ISO strings', () => {
    const rows = [{ doc: { tags: ["it's"] }, at: new Date('2026-10-23T09:00:00.000Z') }]
    expect(extract('sql-inserts', rows, ['doc', 'at'], sql)).toBe(
      `INSERT INTO dbo.Users ([doc], [at]) VALUES (N'{"tags":["it''s"]}', N'2026-10-23T09:00:00.000Z');`
    )
  })

  it('escapes ] in column names and falls back to my_table for a blank Table field', () => {
    expect(
      extract('sql-inserts', [{ 'a]b': 1 }], ['a]b'], { includeHeader: true, tableName: '  ' })
    ).toBe('INSERT INTO my_table ([a]]b]) VALUES (1);')
  })

  it('writes nothing for no rows', () => {
    expect(extract('sql-inserts', [], ['id'], sql)).toBe('')
  })
})

describe('SQL Insert Multirow Extractor', () => {
  const sql: ExtractorOptions = { includeHeader: true, tableName: 't' }

  it('writes one INSERT with a VALUES tuple per row', () => {
    const rows = [
      { id: 1, name: 'a' },
      { id: 2, name: null }
    ]
    expect(extract('sql-insert-multirow', rows, ['id', 'name'], sql)).toBe(
      "INSERT INTO t ([id], [name]) VALUES\n  (1, N'a'),\n  (2, NULL);"
    )
  })

  it('starts a new INSERT every 1,000 rows (the T-SQL VALUES limit)', () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: i }))
    const statements = extract('sql-insert-multirow', rows, ['id'], sql).split(';\n')
    expect(statements).toHaveLength(2)
    expect(statements[0].split('\n')).toHaveLength(1001)
    expect(statements[1]).toBe('INSERT INTO t ([id]) VALUES\n  (1000);')
  })

  it('writes nothing for no rows', () => {
    expect(extract('sql-insert-multirow', [], ['id'], sql)).toBe('')
  })
})

describe('Where Clause Extractor', () => {
  it('ANDs each row’s columns and ORs the rows', () => {
    const rows = [
      { a: 1, b: 'x' },
      { a: 2, b: null }
    ]
    expect(extract('where-clause', rows, ['a', 'b'], withHeader)).toBe(
      "([a] = 1 AND [b] = N'x')\nOR ([a] = 2 AND [b] IS NULL)"
    )
  })

  it('collapses a single column to IN (...)', () => {
    expect(extract('where-clause', [{ id: 1 }, { id: 2 }, { id: 3 }], ['id'], withHeader)).toBe(
      '[id] IN (1, 2, 3)'
    )
  })

  it('matches NULLs in a single column with IS NULL, since IN (NULL) never matches', () => {
    expect(extract('where-clause', [{ id: 1 }, { id: null }], ['id'], withHeader)).toBe(
      '([id] IN (1) OR [id] IS NULL)'
    )
    expect(extract('where-clause', [{}], ['id'], withHeader)).toBe('[id] IS NULL')
  })

  it('writes nothing for no rows or no columns', () => {
    expect(extract('where-clause', [], ['id'], withHeader)).toBe('')
    expect(extract('where-clause', [{ id: 1 }], [], withHeader)).toBe('')
  })
})
