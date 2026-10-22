/**
 * Pure model behind `JsonTree`: turns a result value into a tree of nodes
 * with stable paths, so collapse state, "Expand/Collapse all" and Find can
 * all address the same node without walking React state.
 *
 * Paths: the root is `''`; a child is `${parentPath}/${encodeURIComponent(key)}`,
 * so `/0/address/city` is row 0's `address.city`. Encoding keeps a key that
 * contains `/` from colliding with a deeper path.
 */

export type JsonNode = JsonContainerNode | JsonScalarNode

export interface JsonContainerNode {
  kind: 'container'
  path: string
  bracket: '{' | '['
  entries: JsonEntry[]
  /**
   * True when this container came from a string value holding JSON (an
   * Azure SQL `nvarchar` JSON column, `FOR JSON` output, or a Cosmos field
   * that stores serialized JSON). Display only; Copy/Save still emit the
   * original string.
   */
  parsedFromString: boolean
}

export interface JsonScalarNode {
  kind: 'scalar'
  path: string
  type: 'string' | 'number' | 'boolean' | 'null' | 'undefined'
  /** Display text, without the quotes a string is rendered with. */
  text: string
}

export interface JsonEntry {
  key: string
  node: JsonNode
}

/** One Find hit: an entry's key, or a scalar's value, at `path`. */
export interface JsonMatch {
  path: string
  part: 'key' | 'value'
}

export function buildJsonNode(value: unknown, path = ''): JsonNode {
  if (value === null) return { kind: 'scalar', path, type: 'null', text: 'null' }
  if (Array.isArray(value)) {
    return container(
      path,
      '[',
      value.map((item, index) => [String(index), item]),
      false
    )
  }
  if (typeof value === 'object') return container(path, '{', Object.entries(value), false)
  if (typeof value === 'string') {
    const parsed = parseJsonString(value)
    if (parsed !== undefined) {
      return Array.isArray(parsed)
        ? container(
            path,
            '[',
            parsed.map((item, index) => [String(index), item]),
            true
          )
        : container(path, '{', Object.entries(parsed), true)
    }
    return { kind: 'scalar', path, type: 'string', text: value }
  }
  if (typeof value === 'number') return { kind: 'scalar', path, type: 'number', text: String(value) }
  if (typeof value === 'boolean') {
    return { kind: 'scalar', path, type: 'boolean', text: String(value) }
  }
  return { kind: 'scalar', path, type: 'undefined', text: 'undefined' }
}

function container(
  path: string,
  bracket: '{' | '[',
  pairs: [string, unknown][],
  parsedFromString: boolean
): JsonContainerNode {
  return {
    kind: 'container',
    path,
    bracket,
    entries: pairs.map(([key, value]) => ({
      key,
      node: buildJsonNode(value, `${path}/${encodeURIComponent(key)}`)
    })),
    parsedFromString
  }
}

/**
 * The object or array a string holds, or `undefined` if it isn't one. Only
 * strings shaped like `{…}` / `[…]` are tried, so plain text and JSON
 * scalars (`"42"`, `"true"`) stay strings.
 */
export function parseJsonString(value: string): object | undefined {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Every container path except the root, for "Collapse all". */
export function nestedContainerPaths(root: JsonNode): string[] {
  const paths: string[] = []
  function walk(node: JsonNode): void {
    if (node.kind !== 'container') return
    if (node.path !== root.path && node.entries.length > 0) paths.push(node.path)
    for (const entry of node.entries) walk(entry.node)
  }
  walk(root)
  return paths
}

/**
 * Case-insensitive substring hits over keys and scalar values, in document
 * order (an entry's key before its value). An empty or whitespace-only
 * query matches nothing.
 */
export function findJsonMatches(root: JsonNode, query: string): JsonMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const matches: JsonMatch[] = []
  function walk(node: JsonNode): void {
    if (node.kind === 'scalar') {
      if (node.text.toLowerCase().includes(needle)) matches.push({ path: node.path, part: 'value' })
      return
    }
    for (const entry of node.entries) {
      if (entry.key.toLowerCase().includes(needle)) {
        matches.push({ path: entry.node.path, part: 'key' })
      }
      walk(entry.node)
    }
  }
  walk(root)
  return matches
}

/**
 * The containers that must be expanded for the node at `path` (its key or
 * its value) to be visible: every proper prefix, root included.
 */
export function ancestorPaths(path: string): string[] {
  const segments = path.split('/').slice(1)
  const ancestors = ['']
  for (let i = 1; i < segments.length; i++) {
    ancestors.push('/' + segments.slice(0, i).join('/'))
  }
  return path === '' ? [] : ancestors
}
