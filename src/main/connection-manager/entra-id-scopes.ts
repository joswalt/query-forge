import type { ConnectionConfig } from '@shared/types/connection-profile'

/**
 * The AAD resource scope to request for a given database kind's Entra ID
 * sign-in. Generic, tenant-wide resource scopes (not a per-account/
 * per-server scope) — simpler to reason about and request once per kind,
 * and both resources accept their generic `.default` scope regardless of
 * which specific server/account the token is later used against.
 */
export function scopesForDatabaseKind(kind: ConnectionConfig['kind']): string[] {
  return kind === 'cosmos-db'
    ? ['https://cosmos.azure.com/.default']
    : ['https://database.windows.net/.default']
}
