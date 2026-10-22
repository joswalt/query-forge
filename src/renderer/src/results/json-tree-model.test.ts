import { describe, expect, it } from 'vitest'
import {
  ancestorPaths,
  buildJsonNode,
  findJsonMatches,
  nestedContainerPaths,
  parseJsonString
} from './json-tree-model'

describe('buildJsonNode', () => {
  it('gives every nested object and array its own container node and path', () => {
    const root = buildJsonNode([{ address: { city: 'Bentonville' }, tags: ['a'] }])
    expect(nestedContainerPaths(root)).toEqual(['/0', '/0/address', '/0/tags'])
  })

  it('encodes keys so a key containing "/" does not collide with a deeper path', () => {
    const root = buildJsonNode({ 'a/b': { c: 1 }, a: { b: { c: 2 } } })
    expect(nestedContainerPaths(root)).toEqual(['/a%2Fb', '/a', '/a/b'])
  })

  it('renders a string holding a JSON object or array as a parsed container', () => {
    const root = buildJsonNode({ payload: '{"lens":{"sph":-1.25}}', plain: 'hello' })
    if (root.kind !== 'container') throw new Error('expected container')
    const [payload, plain] = root.entries
    expect(payload.node).toMatchObject({ kind: 'container', bracket: '{', parsedFromString: true })
    expect(plain.node).toMatchObject({ kind: 'scalar', type: 'string', text: 'hello' })
    expect(nestedContainerPaths(root)).toEqual(['/payload', '/payload/lens'])
  })
})

describe('parseJsonString', () => {
  it('parses object and array strings, tolerating surrounding whitespace', () => {
    expect(parseJsonString(' {"a":1} ')).toEqual({ a: 1 })
    expect(parseJsonString('[1,2]')).toEqual([1, 2])
  })

  it('leaves JSON scalars, invalid JSON, and plain text as strings', () => {
    expect(parseJsonString('42')).toBeUndefined()
    expect(parseJsonString('"quoted"')).toBeUndefined()
    expect(parseJsonString('{not json}')).toBeUndefined()
    expect(parseJsonString('[draft] notes')).toBeUndefined()
  })
})

describe('findJsonMatches', () => {
  const root = buildJsonNode([{ Name: 'Frame', model: 'frameless', qty: 3 }])

  it('matches keys and scalar values case-insensitively, in document order', () => {
    expect(findJsonMatches(root, 'FRAME')).toEqual([
      { path: '/0/Name', part: 'value' },
      { path: '/0/model', part: 'value' }
    ])
    expect(findJsonMatches(root, 'name')).toEqual([{ path: '/0/Name', part: 'key' }])
  })

  it('matches numbers by their displayed text', () => {
    expect(findJsonMatches(root, '3')).toEqual([{ path: '/0/qty', part: 'value' }])
  })

  it('matches nothing for an empty or whitespace-only query', () => {
    expect(findJsonMatches(root, '')).toEqual([])
    expect(findJsonMatches(root, '   ')).toEqual([])
  })

  it('searches inside strings that hold JSON', () => {
    const parsed = buildJsonNode({ payload: '{"sku":"ABC-1"}' })
    expect(findJsonMatches(parsed, 'abc')).toEqual([{ path: '/payload/sku', part: 'value' }])
  })
})

describe('ancestorPaths', () => {
  it('lists every container that must be expanded to show a node', () => {
    expect(ancestorPaths('/0/address/city')).toEqual(['', '/0', '/0/address'])
  })

  it('has no ancestors for the root', () => {
    expect(ancestorPaths('')).toEqual([])
  })
})
