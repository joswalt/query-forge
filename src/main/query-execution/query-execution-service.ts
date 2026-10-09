import type { ConnectionConfig, ConnectionProfile } from '@shared/types/connection-profile'
import type { DatabaseProvider } from '@shared/types/database-provider'
import { assertReadOnlyQuery } from './read-only-guard'
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

  constructor(private readonly providerFactory: ProviderFactory) {}

  async handle(
    request: QueryExecutionRequest,
    send: (response: QueryExecutionResponse) => void
  ): Promise<void> {
    try {
      switch (request.method) {
        case 'connect': {
          const provider = this.providerFactory(request.profile.config)
          await provider.connect(request.profile, request.secret)
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
          send({ id: request.id, kind: 'result', value: undefined, done: true })
          return
        }

        case 'getMetadata': {
          const metadata = await this.requireProvider(request.profileId).getMetadata()
          send({ id: request.id, kind: 'result', value: metadata, done: true })
          return
        }

        case 'cancel': {
          this.requireProvider(request.profileId).cancel(request.executionId)
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
        message: err instanceof Error ? err.message : String(err),
        done: true
      })
    }
  }

  private requireProvider(profileId: string): DatabaseProvider {
    const provider = this.providers.get(profileId)
    if (!provider) {
      throw new Error(`No active connection for profile "${profileId}"`)
    }
    return provider
  }
}
