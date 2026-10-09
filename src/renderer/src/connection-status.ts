/** Connection status (user story 10) — tracked client-side; the Query
 * Execution Service itself has no separate "status" concept, only whether
 * a profile id currently has a live provider instance. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * After the shared utilityProcess dies (user story 63) every live provider
 * is gone, so each `connected` profile becomes `error` — surfacing that a
 * reconnect is needed. `connecting` is left alone: its in-flight call is
 * rejected by the client and `handleConnect` sets `error` itself.
 */
export function markConnectionsLost(
  statuses: Record<string, ConnectionStatus>
): Record<string, ConnectionStatus> {
  const next: Record<string, ConnectionStatus> = {}
  for (const [id, status] of Object.entries(statuses)) {
    next[id] = status === 'connected' ? 'error' : status
  }
  return next
}
