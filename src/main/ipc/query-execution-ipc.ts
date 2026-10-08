import { ipcMain } from 'electron'
import type { ConnectionManager } from '../connection-manager/connection-manager'
import type { QueryExecutionClient } from '../query-execution/query-execution-client'
import type { ConnectionProfile, TestConnectionRequest } from '@shared/types/connection-profile'
import type { DatabaseMetadata, TestResult } from '@shared/types/database-provider'

/**
 * Registers the Query Execution Service's connection-lifecycle IPC surface
 * (test/connect/disconnect/metadata) — distinct from `connection-ipc.ts`'s
 * Connection Profile CRUD, mirroring the Connection Manager / Query
 * Execution Service component split (§6). The Connection Manager decrypts
 * (or, for an unsaved profile being tested, simply holds) the secret; the
 * Query Execution Client hands it once to the Query Execution Service
 * (ADR 0001) — this file is the only place those two composе.
 */
export function registerQueryExecutionIpcHandlers(
  manager: ConnectionManager,
  client: QueryExecutionClient
): void {
  ipcMain.handle(
    'connection:test',
    async (_event, request: TestConnectionRequest): Promise<TestResult> => {
      const { profile, secret } = resolveTestSubject(manager, request)
      return client.testConnection(profile, secret)
    }
  )

  ipcMain.handle('connection:connect', async (_event, profileId: string): Promise<void> => {
    const profile = requireProfile(manager, profileId)
    const secret = manager.revealSecret(profileId)
    await client.connect(profile, secret)
  })

  ipcMain.handle('connection:disconnect', async (_event, profileId: string): Promise<void> => {
    await client.disconnect(profileId)
  })

  ipcMain.handle(
    'connection:getMetadata',
    async (_event, profileId: string): Promise<DatabaseMetadata> => client.getMetadata(profileId)
  )
}

function requireProfile(manager: ConnectionManager, profileId: string): ConnectionProfile {
  const profile = manager.get(profileId)
  if (!profile) {
    throw new Error(`Connection profile "${profileId}" does not exist`)
  }
  return profile
}

function resolveTestSubject(
  manager: ConnectionManager,
  request: TestConnectionRequest
): { profile: ConnectionProfile; secret: string | undefined } {
  if ('profileId' in request) {
    const profile = requireProfile(manager, request.profileId)
    return { profile, secret: manager.revealSecret(request.profileId) }
  }

  // Test Connection before saving (user story 6) — a profile-shaped object
  // good enough for the Database Provider Interface's `profile` parameter.
  // Never persisted; `id: 'unsaved'` is never looked up anywhere.
  const profile: ConnectionProfile = {
    id: 'unsaved',
    name: 'Test Connection',
    readOnly: false,
    config: request.config,
    hasSecret: request.secret !== undefined,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  }
  return { profile, secret: request.secret }
}
