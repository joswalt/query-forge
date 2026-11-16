import type { ConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'
import { randomUUID } from 'node:crypto'
import type { DatabaseProvider, DecryptedSecret } from '@shared/types/database-provider'
import { isDocumentWriter } from '@shared/types/document-writer'
import type { DocumentWriter } from '@shared/types/document-writer'
import type { DmlPlanSummary, DmlRetrySummary } from '@shared/types/dml-run'
import { assertReadOnlyQuery, DocumentWriteRefusedError } from './read-only-guard'
import { toExecutionErrorMessage } from './scrub-error-message'
import {
  buildDmlPlan,
  buildRetryPlan,
  commitDmlPlan,
  DmlPlanStore,
  LastCommittedRunStore,
  type DmlPlan,
  type DmlRun
} from './dml-execution'
import type { QueryExecutionRequest, QueryExecutionResponse } from './protocol'

export type ProviderFactory = (config: ConnectionConfig) => DatabaseProvider

/**
 * Query Execution Service (GLOSSARY.md) — the request router that lives
 * inside the shared Electron `utilityProcess`. This class is the
 * plain-Node-testable part of it: dispatching protocol requests to
 * Database Provider instances and emitting responses via the `send`
 * callback, independent of the real `process.parentPort` transport (that
 * wiring lives in `utility-entry.ts`, a thin adapter over this class).
 *
 * Owns live Database Provider instances keyed by Connection Profile id —
 * not by tab — per §6, to avoid fragmenting `mssql`'s per-pool behavior
 * across tabs.
 */
export class QueryExecutionService {
  private readonly providers = new Map<string, DatabaseProvider>()
  private readonly profiles = new Map<string, ConnectionProfile>()
  /** Secret refreshes sent to main and awaiting its `refreshSecretResult`. */
  private readonly pendingRefreshes = new Map<
    string,
    { resolve: (secret: DecryptedSecret) => void; reject: (err: Error) => void }
  >()

  /** Held DML Plans, at most one per tab (ADR 0004 amendments). */
  private readonly dmlPlans = new DmlPlanStore()
  /** Each tab's last committed run, which a Retry re-plans from. */
  private readonly lastCommittedRuns = new LastCommittedRunStore()
  /** Planning and commit runs in progress, by Execution ID, so `cancel`
   * can stop a commit the service itself is dispatching. */
  private readonly dmlRuns = new Map<string, DmlRun>()

  constructor(private readonly providerFactory: ProviderFactory) {}

  async handle(
    request: QueryExecutionRequest,
    send: (response: QueryExecutionResponse) => void
  ): Promise<void> {
    try {
      switch (request.method) {
        case 'connect': {
          const provider = this.providerFactory(request.profile.config)
          // The Provider may call back for a renewed token (Entra ID /
          // service principal) long after this request has been answered;
          // `send` is just the transport to main, so it stays valid.
          await provider.connect(request.profile, request.secret, () =>
            this.requestSecretRefresh(request.profile.id, send)
          )
          this.providers.set(request.profile.id, provider)
          this.profiles.set(request.profile.id, request.profile)
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'testConnection': {
          // Test Connection (GLOSSARY.md) never populates `this.providers`
          // — a throwaway provider instance, scoped to this one call.
          const provider = this.providerFactory(request.profile.config)
          const result = await provider.testConnection(request.profile, request.secret)
          send({ id: request.id, kind: 'result', value: result, done: true })
          return
        }

        case 'disconnect': {
          const provider = this.providers.get(request.profileId)
          if (provider) {
            await provider.disconnect()
            this.providers.delete(request.profileId)
          }
          this.profiles.delete(request.profileId)
          this.dmlPlans.dropProfile(request.profileId)
          this.lastCommittedRuns.dropProfile(request.profileId)
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'getMetadata': {
          const metadata = await this.requireProvider(request.profileId).getMetadata()
          send({ id: request.id, kind: 'result', value: metadata, done: true })
          return
        }

        case 'refreshSecretResult': {
          const pending = this.pendingRefreshes.get(request.id)
          this.pendingRefreshes.delete(request.id)
          if (request.secret !== undefined) pending?.resolve(request.secret)
          else pending?.reject(new Error(request.error ?? 'Could not renew the access token'))
          return
        }

        case 'cancel': {
          const dmlRun = this.dmlRuns.get(request.executionId)
          if (dmlRun) dmlRun.cancelled = true
          this.requireProvider(request.profileId).cancel(request.executionId)
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'writeDocument': {
          // Read-only is a real boundary for Document Writes too (user
          // story 50): refused here, before the provider is touched.
          if (this.profiles.get(request.profileId)?.readOnly) {
            throw new DocumentWriteRefusedError()
          }
          const result = await this.requireDocumentWriter(request.profileId).writeDocument(
            request.write
          )
          send({ id: request.id, kind: 'result', value: result, done: true })
          return
        }

        case 'readDocument': {
          const result = await this.requireDocumentWriter(request.profileId).readDocument(
            request.document
          )
          send({ id: request.id, kind: 'result', value: result, done: true })
          return
        }

        case 'planDml': {
          // Read-only covers bulk writes too (story 74): refused before the
          // Driving Query runs. A new plan replaces the tab's held one.
          if (this.profiles.get(request.profileId)?.readOnly) {
            throw new DocumentWriteRefusedError()
          }
          this.dmlPlans.dropTab(request.tabId)
          // A plan for an ordinary statement ends any Retry of the last run.
          this.lastCommittedRuns.dropTab(request.tabId)
          const writer = this.requireDocumentWriter(request.profileId)
          const plan = await this.trackDmlRun(request.executionId, (run) =>
            buildDmlPlan(
              writer,
              {
                profileId: request.profileId,
                tabId: request.tabId,
                executionId: request.executionId,
                statement: request.statement,
                target: { database: request.database, container: request.container }
              },
              run,
              (progress) => send({ id: request.id, kind: 'progress', value: progress, done: false })
            )
          )
          send({ id: request.id, kind: 'result', value: this.holdPlan(plan), done: true })
          return
        }

        case 'planRetry': {
          const committed = this.lastCommittedRuns.get(request.tabId)
          if (!committed || committed.planId !== request.planId) {
            throw new Error(
              'This run can no longer be retried (another plan in this tab, or its connection closed). ' +
                'Run the statement again.'
            )
          }
          // Read-only covers a Retry too (story 127), before any query runs.
          if (this.profiles.get(committed.profileId)?.readOnly) {
            throw new DocumentWriteRefusedError()
          }
          this.dmlPlans.dropTab(request.tabId)
          const writer = this.requireDocumentWriter(committed.profileId)
          const { plan, scopeCount } = await this.trackDmlRun(request.executionId, (run) =>
            buildRetryPlan(writer, committed, request.executionId, run, (progress) =>
              send({ id: request.id, kind: 'progress', value: progress, done: false })
            )
          )
          const summary: DmlRetrySummary = { ...this.holdPlan(plan), scopeCount }
          send({ id: request.id, kind: 'result', value: summary, done: true })
          return
        }

        case 'commitDml': {
          const plan = this.dmlPlans.get(request.planId)
          if (!plan) {
            throw new Error(
              'This DML Plan is no longer held (it was discarded, replaced, or its connection closed). ' +
                'Run the statement again.'
            )
          }
          if (this.profiles.get(plan.profileId)?.readOnly) throw new DocumentWriteRefusedError()
          const writer = this.requireDocumentWriter(plan.profileId)
          // A plan is written once: committing drops it.
          this.dmlPlans.drop(plan.planId)
          const documents = await this.trackDmlRun(request.executionId, (run) =>
            commitDmlPlan(writer, plan, run, (chunk) =>
              send({ id: request.id, kind: 'chunk', value: chunk, done: false })
            )
          )
          // Replaces the tab's last committed run, a Retry's included.
          this.lastCommittedRuns.keep({
            planId: plan.planId,
            profileId: plan.profileId,
            tabId: plan.tabId,
            statement: plan.statement,
            target: plan.target,
            documents
          })
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'discardPlan': {
          this.dmlPlans.drop(request.planId)
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'releaseTab': {
          this.dmlPlans.dropTab(request.tabId)
          this.lastCommittedRuns.dropTab(request.tabId)
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'executeQuery': {
          const provider = this.requireProvider(request.profileId)
          // Read-only enforcement lives here, in the process that owns the
          // live connection, not in the renderer (user story 59).
          const profile = this.profiles.get(request.profileId)
          if (profile?.readOnly) assertReadOnlyQuery(profile.config, request.query)
          for await (const chunk of provider.executeQuery(request.query, {
            ...request.options,
            executionId: request.executionId
          })) {
            send({ id: request.id, kind: 'chunk', value: chunk, done: false })
          }
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }
      }
    } catch (err) {
      send({
        id: request.id,
        kind: 'error',
        message: toExecutionErrorMessage(err),
        done: true
      })
    }
  }

  /** Holds a plan with matches (zero matches: nothing to confirm, so
   * nothing is held) and returns its summary. */
  private holdPlan(plan: DmlPlan): DmlPlanSummary {
    const matchCount = plan.documents.length
    if (matchCount > 0) this.dmlPlans.hold(plan)
    return {
      ...(matchCount > 0 ? { planId: plan.planId } : {}),
      verb: plan.verb,
      matchCount,
      drivingQueryRequestCharge: plan.drivingQueryRequestCharge,
      ...(plan.averageDocumentSize !== undefined
        ? { averageDocumentSize: plan.averageDocumentSize }
        : {}),
      partitionKeyPaths: plan.partitionKeyPaths,
      sample: plan.sample
    }
  }

  private async trackDmlRun<T>(executionId: string, work: (run: DmlRun) => Promise<T>): Promise<T> {
    const run: DmlRun = { cancelled: false }
    this.dmlRuns.set(executionId, run)
    try {
      return await work(run)
    } finally {
      this.dmlRuns.delete(executionId)
    }
  }

  private requestSecretRefresh(
    profileId: string,
    send: (response: QueryExecutionResponse) => void
  ): Promise<DecryptedSecret> {
    return new Promise<DecryptedSecret>((resolve, reject) => {
      const id = randomUUID()
      this.pendingRefreshes.set(id, { resolve, reject })
      send({ id, kind: 'refreshSecret', profileId })
    })
  }

  /** The DocumentWriter capability check (ADR 0004): only the Cosmos DB
   * Provider implements it; the Database Provider Interface stays as is. */
  private requireDocumentWriter(profileId: string): DocumentWriter {
    const provider = this.requireProvider(profileId)
    if (!isDocumentWriter(provider)) {
      throw new Error('Document Writes are only supported on Cosmos DB connections.')
    }
    return provider
  }

  private requireProvider(profileId: string): DatabaseProvider {
    const provider = this.providers.get(profileId)
    if (!provider) {
      throw new Error(`No active connection for profile "${profileId}"`)
    }
    return provider
  }
}
