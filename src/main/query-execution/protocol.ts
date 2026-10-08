import type { ConnectionProfile } from '@shared/types/connection-profile'
import type {
  DecryptedSecret,
  ExecutionId,
  QueryOptions,
  ResultChunk,
  TestResult,
  DatabaseMetadata
} from '@shared/types/database-provider'

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
  | { id: RequestId; kind: 'result'; value: TestResult | DatabaseMetadata | undefined; done: true }
  | { id: RequestId; kind: 'error'; message: string; done: true }
