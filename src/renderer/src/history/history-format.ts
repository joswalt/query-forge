const DAY = 24 * 60 * 60 * 1000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * The heading a Query History Entry is listed under: "Today", "Yesterday",
 * a weekday within the last week, then a date ("Nov 17", with the year
 * only when it isn't this year). Calendar days in local time, not 24h spans.
 */
export function historyDayLabel(executedAt: string, now: Date = new Date()): string {
  const then = new Date(executedAt)
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return then.toLocaleDateString('en-US', { weekday: 'long' })
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  })
}

/** Time of day within a day group, e.g. "3:04 PM". */
export function historyTimeLabel(executedAt: string): string {
  return new Date(executedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export interface HistoryDay<T> {
  label: string
  entries: T[]
}

/** Splits entries (already most recent first) into consecutive day groups. */
export function groupHistoryByDay<T extends { executedAt: string }>(
  entries: readonly T[],
  now: Date = new Date()
): HistoryDay<T>[] {
  const days: HistoryDay<T>[] = []
  for (const entry of entries) {
    const label = historyDayLabel(entry.executedAt, now)
    const last = days[days.length - 1]
    if (last?.label === label) last.entries.push(entry)
    else days.push({ label, entries: [entry] })
  }
  return days
}

/** "412 ms" under a second, then "2.4 s" — one rule for queries and DML runs. */
export function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`
}

/** "5,321 rows", "1 row". */
export function formatRowCount(rowCount: number): string {
  return `${rowCount.toLocaleString('en-US')} ${rowCount === 1 ? 'row' : 'rows'}`
}

/** The first non-blank line of a query, for a one-line title. */
export function firstQueryLine(queryText: string): string {
  return (
    queryText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}
