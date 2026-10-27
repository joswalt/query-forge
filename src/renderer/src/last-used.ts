const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "last used 2h ago" for a Connection Profile's `lastConnectedAt` (user
 * story 11). Shown on each disconnected row in place of a separate Recent
 * list, so the list order (and muscle memory around prod rows) never shifts.
 */
export function formatLastUsed(lastConnectedAt: string, now: Date = new Date()): string {
  const then = new Date(lastConnectedAt)
  const elapsed = Math.max(0, now.getTime() - then.getTime())
  if (elapsed < MINUTE) return 'last used just now'
  if (elapsed < HOUR) return `last used ${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `last used ${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 2 * DAY) return 'last used yesterday'
  if (elapsed < 7 * DAY) return `last used ${Math.floor(elapsed / DAY)}d ago`
  const date = then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  })
  return `last used ${date}`
}
