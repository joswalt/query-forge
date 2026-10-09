import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type {
  DatabaseMetadata,
  DecryptedSecret,
  ExecutionId,
  QueryOptions,
  ResultChunk,
  TestResult
} from '@shared/types/database-provider'
import type { QueryExecutionRequest, QueryExecutionResponse } from './protocol'
import { AsyncQueue } from './async-queue'

interface PendingResult {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * Main-side counterpart to `utility-entry.ts` — forks the shared Query
 * Execution Service `utilityProcess` once (lazily, on first use) and tags
 * each call with a Request ID so replies can be correlated on an
 * otherwise-unordered `MessagePort`. The `connection:*` IPC handlers call
 * into this; the renderer never does directly (§6).
 *
 * The main↔utility Decrypted Secret handoff (ADR 0001) happens at the
 * `connect()` call below: `secret` crosses this boundary exactly once per
 * connection, is never logged, and is not retained by this class beyond
 * the single `postMessage` call.
 *
 * Confirmed seam (see Phase 2 planning): not unit-tested here — this is
 * thin Electron `utilityProcess`/`MessagePort` plumbing around the
 * already-unit-tested `QueryExecutionService`, better exercised by a
 * Playwright-Electron integration test than by mocking `utilityProcess` in
 * Vitest. Smoke-test via `npm run dev` after changes here.
 */
export class QueryExecutionClient {
  private child: UtilityProcess | undefined
  private readonly pendingResults = new Map<string, PendingResult>()
  private readonly pendingStreams = new Map<string, AsyncQueue<ResultChunk>>()

  private unexpectedExitListener: (() => void) | undefined
  private secretRefresher: ((profileId: string) => Promise<DecryptedSecret>) | undefined

  constructor(private readonly utilityModulePath: string) {}

  /** Registers the single listener notified when the utilityProcess dies
   * unexpectedly (not via `shutdown()`), so main can tell the renderer its
   * "connected" statuses are stale (user story 63). */
  onUnexpectedExit(listener: () => void): void {
    this.unexpectedExitListener = listener
  }

  /** Registers how main renews a connected profile's access token when the
   * utilityProcess asks for one mid-session (docs/adr/0002-...). */
  onSecretRefreshRequested(refresher: (profileId: string) => Promise<DecryptedSecret>): void {
    this.secretRefresher = refresher
  }

  async connect(profile: ConnectionProfile, secret: DecryptedSecret | undefined): Promise<void> {
    await this.sendForResult({ id: randomUUID(), method: 'connect', profile, secret })
  }

  async testConnection(
    profile: ConnectionProfile,
    secret: DecryptedSecret | undefined
  ): Promise<TestResult> {
    return this.sendForResult<TestResult>({
      id: randomUUID(),
      method: 'testConnection',
      profile,
      secret
    })
  }

  async disconnect(profileId: string): Promise<void> {
    await this.sendForResult({ id: randomUUID(), method: 'disconnect', profileId })
  }

  async getMetadata(profileId: string): Promise<DatabaseMetadata> {
    return this.sendForResult<DatabaseMetadata>({
      id: randomUUID(),
      method: 'getMetadata',
      profileId
    })
  }

  /** Fire-and-forget by design, mirroring `DatabaseProvider.cancel()`'s own
   * synchronous void signature — a failed cancel has nothing meaningful to
   * surface back to a caller that isn't awaiting anything. */
  cancel(profileId: string, executionId: ExecutionId): void {
    this.sendForResult({ id: randomUUID(), method: 'cancel', profileId, executionId }).catch(
      () => {}
    )
  }

  executeQuery(
    profileId: string,
    executionId: ExecutionId,
    query: string,
    options?: QueryOptions
  ): AsyncIterable<ResultChunk> {
    const id = randomUUID()
    const queue = new AsyncQueue<ResultChunk>()
    this.pendingStreams.set(id, queue)
    this.ensureChild().postMessage({ id, method: 'executeQuery', profileId, executionId, query, options })
    return queue
  }

  /** Terminates the shared utilityProcess. Call on app quit. */
  shutdown(): void {
    const child = this.child
    this.child = undefined
    child?.kill()
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(this.utilityModulePath, [], {
      serviceName: 'QueryForge Query Execution Service'
    })
    child.on('message', (message: QueryExecutionResponse) => this.onMessage(message))
    // User story 63: if the utilityProcess dies (crash, OOM), every in-flight
    // call would otherwise hang forever. Reject them with an actionable
    // message and drop the dead handle so the next call forks a fresh child.
    // The new child has no live providers, so connections must be re-established.
    child.on('exit', () => {
      // `shutdown()` clears `this.child` before killing, so a deliberate
      // quit never counts as unexpected.
      const unexpected = this.child === child
      if (unexpected) this.child = undefined
      this.failAllPending(
        new Error(
          'The query execution service stopped unexpectedly. Reconnect, then retry.'
        )
      )
      if (unexpected) this.unexpectedExitListener?.()
    })
    this.child = child
    return child
  }

  /** The renewed token crosses main→utility exactly like the one handed over
   * at `connect()` (ADR 0001/0002): never logged, not retained here. */
  private async answerSecretRefresh(id: string, profileId: string): Promise<void> {
    let reply: QueryExecutionRequest
    try {
      if (!this.secretRefresher) throw new Error('Token renewal is not configured')
      reply = { id, method: 'refreshSecretResult', secret: await this.secretRefresher(profileId) }
    } catch (err) {
      reply = {
        id,
        method: 'refreshSecretResult',
        error: err instanceof Error ? err.message : String(err)
      }
    }
    // The child may have exited while main was renewing; nothing to answer then.
    this.child?.postMessage(reply)
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pendingResults.values()) pending.reject(error)
    this.pendingResults.clear()
    for (const stream of this.pendingStreams.values()) stream.fail(error)
    this.pendingStreams.clear()
  }

  private sendForResult<T>(request: QueryExecutionRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pendingResults.set(request.id, { resolve: resolve as (value: unknown) => void, reject })
      this.ensureChild().postMessage(request)
    })
  }

  private onMessage(response: QueryExecutionResponse): void {
    if (response.kind === 'refreshSecret') {
      void this.answerSecretRefresh(response.id, response.profileId)
      return
    }

    if (response.kind === 'chunk') {
      this.pendingStreams.get(response.id)?.push(response.value)
      return
    }

    const stream = this.pendingStreams.get(response.id)
    if (stream) {
      this.pendingStreams.delete(response.id)
      if (response.kind === 'error') stream.fail(new Error(response.message))
      else stream.close()
      return
    }

    const pending = this.pendingResults.get(response.id)
    if (!pending) return
    this.pendingResults.delete(response.id)
    if (response.kind === 'error') pending.reject(new Error(response.message))
    else pending.resolve(response.value)
  }
}
