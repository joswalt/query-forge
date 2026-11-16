import { describe, expect, it } from 'vitest'
import { partitionKeyPathSegments, readPartitionKeyPath } from './partition-key-path'

describe('partition key path segments', () => {
  it.each<[string, string[]]>([
    ['/customerId', ['customerId']],
    ['/address/zip', ['address', 'zip']],
    ['/"odd key"', ['odd key']],
    ["/'odd key'", ['odd key']],
    ['/"a/b"/c', ['a/b', 'c']],
    ['/"tenant-id"/region', ['tenant-id', 'region']],
    ['/ padded ', ['padded']],
    ['/a~1b', ['a~1b']],
    ['/"say \\"hi\\""', ['say \\"hi\\"']]
  ])('%j reads as %j', (path, segments) => {
    expect(partitionKeyPathSegments(path)).toEqual(segments)
  })

  it.each(['customerId', '/"unterminated'])('refuses the malformed path %j', (path) => {
    expect(() => partitionKeyPathSegments(path)).toThrow(/invalid/)
  })
})

describe('reading a partition key path from a document', () => {
  it.each<[string, Record<string, unknown>, ReturnType<typeof readPartitionKeyPath>]>([
    ['/customerId', { customerId: 'c1' }, { found: true, value: 'c1' }],
    ['/customerId', { customerId: null }, { found: true, value: null }],
    ['/customerId', {}, { found: false }],
    ['/address/zip', { address: { zip: '90210' } }, { found: true, value: '90210' }],
    ['/address/zip', { address: ['90210'] }, { found: false }],
    ['/"a/b"', { 'a/b': 1 }, { found: true, value: 1 }],
    ['/toString', {}, { found: false }]
  ])('%j in %j', (path, document, read) => {
    expect(readPartitionKeyPath(document, path)).toEqual(read)
  })
})
