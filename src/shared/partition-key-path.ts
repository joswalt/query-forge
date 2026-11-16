import { isRecord } from './is-record'

/**
 * A Cosmos DB partition key path (`/customerId`, `/address/zip`) as its
 * property names. The one parser every caller uses, so the renderer's
 * Addressable Row check, the DML translator and the Cosmos DB Provider can
 * never disagree about which property a path names.
 *
 * The rule is the one `@azure/cosmos` 4.10.1 applies when it extracts a
 * partition key from a document (`parsePath`), not JSON pointer escaping:
 * each segment follows a `/`; a segment opening with `"` or `'` runs to the
 * matching quote not preceded by a backslash (so it may contain `/`) and is
 * kept verbatim between the quotes; any other segment runs to the next `/`
 * and is trimmed. Paths come from the container definition, which Cosmos
 * DB validated, so a malformed one is refused as the SDK refuses it.
 */
export function partitionKeyPathSegments(path: string): string[] {
  const segments: string[] = []
  let index = 0
  const invalid = (): never => {
    throw new Error(`Partition key path ${path} is invalid at index ${index}`)
  }
  while (index < path.length) {
    if (path[index] !== '/') invalid()
    index++
    if (index === path.length) break
    const quote = path[index]
    if (quote === '"' || quote === "'") {
      const start = ++index
      let end = path.indexOf(quote, start)
      while (end !== -1 && path[end - 1] === '\\') end = path.indexOf(quote, end + 1)
      if (end === -1) invalid()
      segments.push(path.slice(start, end))
      index = end + 1
    } else {
      const next = path.indexOf('/', index)
      const end = next === -1 ? path.length : next
      segments.push(path.slice(index, end).trim())
      index = end
    }
  }
  return segments
}

/** Reads the property a partition key path names; `found: false` when any
 * step is missing or isn't a JSON object. */
export function readPartitionKeyPath(
  document: unknown,
  path: string
): { found: true; value: unknown } | { found: false } {
  return readPath(document, partitionKeyPathSegments(path))
}

/** Reads a nested property by segments; `found: false` when any step is
 * missing (own properties only) or isn't a JSON object. */
export function readPath(
  value: unknown,
  segments: readonly string[]
): { found: true; value: unknown } | { found: false } {
  let current = value
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false }
    current = current[segment]
  }
  return { found: true, value: current }
}
