import type {
  QueryHistoryEntry,
  QueryHistoryRepository,
  RecordQueryHistoryInput
} from '../local-storage/query-history-repository'

/** Oldest text is dropped past this many entries, so a long session can't
 * grow main's memory without bound. Well above the history list limit. */
const MAX_HELD = 1_000

/**
 * Session Query Text (GLOSSARY.md): the query text of Query History Entries
 * recorded while Preferences has not opted into persisting it, held in
 * main's memory only. It lets this session's history show, search and
 * reopen what was run without ever writing the text to disk (user story
 * 53 is about data at rest), and it is gone when QueryForge quits.
 */
export class SessionQueryText {
  private readonly texts = new Map<string, string>()

  remember(entryId: string, queryText: string): void {
    this.texts.set(entryId, queryText)
    if (this.texts.size > MAX_HELD) {
      const oldest = this.texts.keys().next().value
      if (oldest !== undefined) this.texts.delete(oldest)
    }
  }

  clear(): void {
    this.texts.clear()
  }

  /** Adds held text to entries whose text was withheld from disk. */
  fill(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
    return entries.map((entry) => {
      const held = entry.queryText === undefined ? this.texts.get(entry.id) : undefined
      return held === undefined ? entry : { ...entry, queryText: held, queryTextSessionOnly: true }
    })
  }

  /** Entry ids whose held text contains `term`, case-insensitively like the
   * repository's `LIKE` search. */
  matching(term: string): string[] {
    const needle = term.toLowerCase()
    return [...this.texts]
      .filter(([, text]) => text.toLowerCase().includes(needle))
      .map(([id]) => id)
  }
}

/**
 * Records one Query History Entry from an input that carries the full query
 * text. The text goes to disk only when `persistQueryText` is on; otherwise
 * it is withheld from the row and held as Session Query Text instead.
 */
export function recordQueryHistory(
  repository: Pick<QueryHistoryRepository, 'record'>,
  sessionText: SessionQueryText,
  input: RecordQueryHistoryInput,
  persistQueryText: boolean
): QueryHistoryEntry {
  if (persistQueryText || input.queryText === undefined) return repository.record(input)
  const entry = repository.record({ ...input, queryText: undefined })
  sessionText.remember(entry.id, input.queryText)
  return entry
}

/** Most recent first, the repository's order. */
function byExecutedAtDesc(a: QueryHistoryEntry, b: QueryHistoryEntry): number {
  return a.executedAt < b.executedAt ? 1 : a.executedAt > b.executedAt ? -1 : 0
}

/**
 * History search across both stores: the repository's matches (profile
 * name, persisted text, container, verb) plus entries whose Session Query
 * Text matches, merged most recent first.
 */
export function searchQueryHistory(
  repository: Pick<QueryHistoryRepository, 'search' | 'get'>,
  sessionText: SessionQueryText,
  term: string,
  limit?: number
): QueryHistoryEntry[] {
  const found = repository.search(term, limit)
  const seen = new Set(found.map((entry) => entry.id))
  const extra = sessionText
    .matching(term)
    .filter((id) => !seen.has(id))
    .map((id) => repository.get(id))
    .filter((entry): entry is QueryHistoryEntry => entry !== undefined)
  if (extra.length === 0) return sessionText.fill(found)
  const merged = [...found, ...extra].sort(byExecutedAtDesc)
  return sessionText.fill(limit === undefined ? merged : merged.slice(0, limit))
}
