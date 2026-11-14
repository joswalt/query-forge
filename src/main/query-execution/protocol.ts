import type { ConnectionProfile } from '@shared/types/connection-profile'
import type {
  DecryptedSecret,
  ExecutionId,
  QueryOptions,
  ResultChunk,
  TestResult,
  DatabaseMetadata
} from '@shared/types/database-provider'
import type {
  DocumentWrite,
  DocumentWriteResult,
  ReadDocumentRequest,
  ReadDocumentResult
} from '@shared/types/document-writer'

/**
 * Correlation id for one request/response exchange over the main↔utility
 * `MessagePort` (ADR 0001). Distinct from Execution ID, which addresses one
 * in-flight `executeQuery` call for `cancel()` — every protocol request
 * gets a Request ID, but only `executeQuery` requests also carry an
 * Execution ID.
 */
export type RequestId = string

export type QueryExecutionRequest =
  | { id: RequestId; method: 'connect'; profile: ConnectionProfile; secret: DecryptedSecret | undefined }
  | {
      id: RequestId
      method: 'testConnection'
      profile: ConnectionProfile
      secret: DecryptedSecret | undefined
    }
  | { id: RequestId; method: 'disconnect'; profileId: string }
  | {
      id: RequestId
      method: 'executeQuery'
      profileId: string
      executionId: ExecutionId
      query: string
      options?: QueryOptions
    }
  | { id: RequestId; method: 'cancel'; profileId: string; executionId: ExecutionId }
  | { id: RequestId; method: 'getMetadata'; profileId: string }
  /** One Document Write (ADR 0004); refused on a read-only profile. */
  | { id: RequestId; method: 'writeDocument'; profileId: string; write: DocumentWrite }
  /** A point-read of one document; a read, so read-only doesn't refuse it.
   * The address is nested because `id` is already the Request ID here. */
  | { id: RequestId; method: 'readDocument'; profileId: string; document: ReadDocumentRequest }
  /** Main's answer to a `refreshSecret` response (same `id`): the renewed
   * Decrypted Secret, or why it couldn't be renewed. */
  | { id: RequestId; method: 'refreshSecretResult'; secret?: DecryptedSecret; error?: string }

/**
 * `chunk` responses (`done: false`) may be sent zero or more times per
 * Request ID before exactly one terminal `result` or `error` response
 * (`done: true`) — only `executeQuery` ever sends `chunk` responses; every
 * other method goes straight to a single terminal response. This shape is
 * deliberately many-replies-capable even though Phase 2's own methods
 * (`connect`/`testConnection`/`disconnect`/`getMetadata`) only ever need
 * one reply, so `executeQuery`'s streaming doesn't force a protocol
 * rewrite later.
 */
export type QueryExecutionResponse =
  | { id: RequestId; kind: 'chunk'; value: ResultChunk; done: false }
  | {
      id: RequestId
      kind: 'result'
      value: TestResult | DatabaseMetadata | DocumentWriteResult | ReadDocumentResult | undefined
      done: true
    }
  | { id: RequestId; kind: 'error'; message: string; done: true }
  /**
   * Utility → main: a connected Provider needs a newer access token for
   * `profileId` (docs/adr/0002-refresh-entra-tokens-over-the-message-port.md).
   * Unlike every other response this opens a new exchange rather than
   * answering a request: `id` is fresh, and main replies with a
   * `refreshSecretResult` request carrying the same `id`.
   */
  | { id: RequestId; kind: 'refreshSecret'; profileId: string }
