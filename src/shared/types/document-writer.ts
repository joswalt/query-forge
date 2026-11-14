/**
 * One level of a Cosmos DB partition key value: a scalar, JSON `null` (the
 * `null` partition), or `{}` (the None value: the document has no such
 * property). Mirrors `@azure/cosmos`'s `PrimitivePartitionKeyValue`.
 */
export type PartitionKeyLevelValue = string | number | boolean | null | Record<string, never>

/**
 * The partition key value that, with `id`, addresses one document: a single
 * level, or an array of levels for a hierarchical key (up to 3, `{}` for a
 * missing level). Always passed explicitly to every SDK point operation,
 * because `@azure/cosmos` silently targets the None key when one is left
 * out (ADR 0004).
 */
export type PartitionKeyValue = PartitionKeyLevelValue | PartitionKeyLevelValue[]

/** A patch operation of a `patch` Document Write: `set` or `remove` only,
 * at most 10 per write (the service cap, ADR 0004 amendment). `path` is a
 * JSON pointer such as `/address/zip`. */
export type DocumentPatchOperation =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'remove'; path: string }

/** The service cap on operations in one `patch` Document Write. */
export const MAX_PATCH_OPERATIONS = 10

/**
 * A Document Write (GLOSSARY.md): one create, replace, patch or delete of a
 * single document, addressed by `id` and partition key value. `database` /
 * `container` fall back to the Connection Profile's, as `QueryOptions`
 * does. `ifMatch` is required wherever an existing document is changed, so
 * no write can overwrite a Concurrent Change. No upsert (it would hide the
 * `id` clash).
 */
export type DocumentWrite =
  | {
      kind: 'create'
      id: string
      partitionKey: PartitionKeyValue
      body: object
      database?: string
      container?: string
    }
  | {
      kind: 'replace'
      id: string
      partitionKey: PartitionKeyValue
      body: object
      ifMatch: string
      database?: string
      container?: string
    }
  | {
      kind: 'patch'
      id: string
      partitionKey: PartitionKeyValue
      ifMatch: string
      operations: DocumentPatchOperation[]
      database?: string
      container?: string
    }
  | {
      kind: 'delete'
      id: string
      partitionKey: PartitionKeyValue
      ifMatch: string
      database?: string
      container?: string
    }

/** A stored document as the server returned it, system properties included. */
export type StoredDocument = Record<string, unknown>

/**
 * What a Document Write came to. Expected failures are typed outcomes, not
 * errors: `conflict` is only the `id` clash on create (409),
 * `precondition-failed` is a Concurrent Change (412), `not-found` is 404.
 * Anything else is thrown and reported through the scrubbed-message path.
 * `document` is the stored document on success, absent for delete.
 */
export type DocumentWriteResult =
  | { outcome: 'success'; document?: StoredDocument; requestCharge: number }
  | { outcome: 'conflict' | 'precondition-failed' | 'not-found'; requestCharge: number }

/** A point-read of one document (ADR 0004 amendment, Editable rows). */
export interface ReadDocumentRequest {
  id: string
  partitionKey: PartitionKeyValue
  database?: string
  container?: string
}

export type ReadDocumentResult =
  | { outcome: 'success'; document: StoredDocument; requestCharge: number }
  | { outcome: 'not-found'; requestCharge: number }

/** Per-write options a caller inside the Query Execution Service may set;
 * never part of the `writeDocument` protocol request. `priorityLevel: 'Low'`
 * is for DML Statement runs, so bulk work yields to application traffic. */
export interface DocumentWriteOptions {
  priorityLevel?: 'Low'
}

/**
 * Cosmos DB only capability (ADR 0004), implemented by the Cosmos DB
 * Provider beside the unchanged Database Provider Interface. The Query
 * Execution Service checks for it with `isDocumentWriter` before
 * dispatching a `writeDocument` or `readDocument` request, and refuses a
 * Document Write on a read-only Connection Profile before the provider is
 * touched. A single Document Write can't be cancelled; the profile's
 * request timeout applies.
 */
export interface DocumentWriter {
  writeDocument(write: DocumentWrite, options?: DocumentWriteOptions): Promise<DocumentWriteResult>
  readDocument(request: ReadDocumentRequest): Promise<ReadDocumentResult>
}

export function isDocumentWriter(provider: unknown): provider is DocumentWriter {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    typeof (provider as Partial<DocumentWriter>).writeDocument === 'function' &&
    typeof (provider as Partial<DocumentWriter>).readDocument === 'function'
  )
}
