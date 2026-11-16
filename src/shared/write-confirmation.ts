import type { DmlVerb } from './dml/dml-statement'
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

/**
 * What a DML Statement's Write Confirmation on prod asks the user to type:
 * the verb and the document count, e.g. `DELETE 1840` (story 84). Typing
 * the count makes the user read it, which catches a `WHERE` that matches
 * more than meant.
 */
export function typedDmlConfirmation(verb: DmlVerb, matchCount: number): string {
  return `${verb} ${matchCount}`
}

/**
 * Does the typed text confirm this DML Statement on prod? The verb is
 * case-insensitive; the count must be exactly the plan's, digits only.
 * Surrounding and repeated spaces are tolerated, anything else is not.
 */
export function matchesTypedDmlConfirmation(
  typed: string,
  verb: DmlVerb,
  matchCount: number
): boolean {
  const [typedVerb, typedCount, ...rest] = typed.trim().split(/\s+/)
  return (
    rest.length === 0 &&
    typedVerb?.toUpperCase() === verb &&
    typedCount === String(matchCount)
  )
}
