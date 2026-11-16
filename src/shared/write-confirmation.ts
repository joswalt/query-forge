import type { ConnectionEnvironment } from './types/connection-profile'

/**
 * Does this Connection Profile require a Write Confirmation? True only on a
 * prod Environment; there is no per-profile override (decision 05). Shared by
 * both engines: Cosmos DB asks it for every Document Write from the drawer and
 * for DML Statements, and the Azure SQL write-safety guard asks it for
 * destructive statements, each with its own trigger and surface.
 *
 * Call it with the current profile when the write is pressed, never a copy
 * cached at open time, so an Environment edited meanwhile is honoured. A
 * speed bump only: the renderer applies it, no request carries a
 * `confirmed` flag, and read-only stays the only enforced write gate.
 */
export function requiresWriteConfirmation(
  profile: { environment?: ConnectionEnvironment } | undefined
): boolean {
  return profile?.environment === 'prod'
}
