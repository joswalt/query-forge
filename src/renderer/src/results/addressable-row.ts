import { isRecord } from '@shared/is-record'
import type { PartitionKeyLevelValue, PartitionKeyValue } from '@shared/types/document-writer'

/** What addresses one Cosmos DB document: `id` plus its partition key value. */
export interface DocumentAddress {
  id: string
  partitionKey: PartitionKeyValue
}

export type AddressCheck =
  | { addressable: true; address: DocumentAddress }
  | {
      addressable: false
      /** The fields the row lacks (`id` and/or partition key fields, as
       * dotted names), empty when the row isn't a JSON object at all. */
      missing: string[]
    }

/** The system properties every stored document carries; a row with all four
 * is a full document, not a projection. */
const FULL_DOCUMENT_MARKERS = ['_rid', '_self', '_etag', '_ts'] as const

/** `/address/zip` → `['address', 'zip']` (JSON pointer unescaping). */
export function partitionKeyPathSegments(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** `/address/zip` → `address.zip`, how a partition key field is named to the user. */
export function partitionKeyFieldName(path: string): string {
  return partitionKeyPathSegments(path).join('.')
}

/** Reads a nested property; `found: false` when any step is missing. */
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

/** A row carrying the system properties: a whole stored document. */
export function isFullDocument(row: Record<string, unknown>): boolean {
  return FULL_DOCUMENT_MARKERS.every((marker) => Object.hasOwn(row, marker))
}

function isLevelValue(value: unknown): value is PartitionKeyLevelValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

/**
 * Whether a result row is an Addressable Row (GLOSSARY.md) of a container
 * with these partition key paths, and if so its address. Pure, so the grid
 * can ask per row.
 *
 * - A JSON object with a string `id` and a known value for every partition
 *   key path (one level per path; hierarchical keys give an array).
 * - JSON `null` is known: it addresses the `null` partition.
 * - A missing property is the None value (`{}`) only on a full document
 *   (`_rid`, `_self`, `_etag`, `_ts` present); in a projection it is unknown,
 *   since Cosmos drops `undefined` from projections.
 * - Absent partition key paths (no `meta.partitionKeyPaths`) mean nothing is
 *   addressable.
 */
export function addressOf(row: unknown, partitionKeyPaths: readonly string[] | undefined): AddressCheck {
  if (!isRecord(row) || !partitionKeyPaths || partitionKeyPaths.length === 0) {
    return { addressable: false, missing: [] }
  }
  const missing: string[] = []
  if (typeof row.id !== 'string') missing.push('id')

  const fullDocument = isFullDocument(row)
  const levels: PartitionKeyLevelValue[] = []
  for (const path of partitionKeyPaths) {
    const read = readPath(row, partitionKeyPathSegments(path))
    if (read.found && isLevelValue(read.value)) levels.push(read.value)
    else if (!read.found && fullDocument) levels.push({})
    else missing.push(partitionKeyFieldName(path))
  }

  if (missing.length > 0) return { addressable: false, missing }
  return {
    addressable: true,
    address: { id: row.id as string, partitionKey: levels.length === 1 ? levels[0] : levels }
  }
}

/** Whether two addresses name the same document. Structural, since a
 * partition key value can be `null`, `{}` (None) or a hierarchical array. */
export function sameAddress(a: DocumentAddress, b: DocumentAddress): boolean {
  return a.id === b.id && JSON.stringify(a.partitionKey) === JSON.stringify(b.partitionKey)
}

/**
 * The disabled Edit/Delete tooltip: which fields an Addressable Row needs,
 * and how to get them.
 */
export function notAddressableReason(
  partitionKeyPaths: readonly string[] | undefined,
  missing: readonly string[]
): string {
  if (!partitionKeyPaths || partitionKeyPaths.length === 0) {
    return "QueryForge doesn't know this container's partition key, so its rows can't be edited."
  }
  const required = ['id', ...partitionKeyPaths.map(partitionKeyFieldName)]
  const lacks = missing.length > 0 ? `This row has no ${joinNames(missing)}. ` : ''
  return `${lacks}Only rows with ${joinNames(required)} can be edited. Re-run with SELECT * (or include them) to edit.`
}

function joinNames(names: readonly string[]): string {
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * `_rid` guard: the row came from a document that was deleted and recreated
 * at the same address since the query ran, so editing the server copy would
 * edit a different document than the one shown.
 */
export function isOutOfDate(row: unknown, serverCopy: Record<string, unknown>): boolean {
  return isRecord(row) && typeof row._rid === 'string' && row._rid !== serverCopy._rid
}
