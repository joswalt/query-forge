import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { DmlVerb } from '@shared/dml/dml-statement'
import type {
  DmlHistoryDetail,
  QueryHistoryEntry,
  QueryHistoryStatus
} from '@shared/types/query-history'

export type { DmlHistoryDetail, QueryHistoryEntry, QueryHistoryStatus }

export interface RecordQueryHistoryInput {
  profileId: string
  profileName: string
  /** Omitted entirely when Preferences has not opted into persisting query
   * text (user story 53) — never stored as an empty string standing in for
   * "withheld", so a reader can't confuse "empty query" with "redacted". */
  queryText: string | undefined
  status: QueryHistoryStatus
  durationMs: number
  rowCount?: number
  errorMessage?: string
  /** When the run started (ISO). Defaults to the recording time; a DML
   * Statement run passes its commit start (planning start without a plan). */
  executedAt?: string
  /** Only for a DML Statement run. */
  dml?: DmlHistoryDetail
}

interface QueryHistoryRow {
  id: string
  profile_id: string
  profile_name: string
  query_text: string | null
  status: QueryHistoryStatus
  duration_ms: number
  row_count: number | null
  error_message: string | null
  executed_at: string
  entry_kind: 'query' | 'dml'
  dml_verb: DmlVerb | null
  database_name: string | null
  container_name: string | null
  written_count: number | null
  unchanged_count: number | null
  concurrent_change_count: number | null
  not_found_count: number | null
  expression_undefined_count: number | null
  failed_count: number | null
  not_attempted_count: number | null
  total_request_charge: number | null
  is_retry: 0 | 1 | null
}

const DEFAULT_LIST_LIMIT = 200

/**
 * Local Storage Service component owning Query History Entry persistence
 * (GLOSSARY.md: "Query History Entry") — automatically recorded after every
 * query run completes, never written to directly by the renderer (§6
 * component boundaries, same proxy rule as Connection Profile CRUD).
 */
export class QueryHistoryRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordQueryHistoryInput): QueryHistoryEntry {
    const id = randomUUID()
    const executedAt = input.executedAt ?? new Date().toISOString()
    const { dml } = input
    this.db
      .prepare(
        `INSERT INTO query_history
           (id, profile_id, profile_name, query_text, status, duration_ms, row_count, error_message, executed_at,
            entry_kind, dml_verb, database_name, container_name,
            written_count, unchanged_count, concurrent_change_count, not_found_count,
            expression_undefined_count, failed_count, not_attempted_count,
            total_request_charge, is_retry)
         VALUES (@id, @profileId, @profileName, @queryText, @status, @durationMs, @rowCount, @errorMessage, @executedAt,
            @entryKind, @verb, @databaseName, @containerName,
            @written, @unchanged, @concurrentChange, @notFound,
            @expressionUndefined, @failed, @notAttempted,
            @totalRequestCharge, @retry)`
      )
      .run({
        id,
        profileId: input.profileId,
        profileName: input.profileName,
        queryText: input.queryText ?? null,
        status: input.status,
        durationMs: input.durationMs,
        rowCount: input.rowCount ?? null,
        errorMessage: input.errorMessage ?? null,
        executedAt,
        entryKind: dml ? 'dml' : 'query',
        verb: dml?.verb ?? null,
        databaseName: dml?.databaseName ?? null,
        containerName: dml?.containerName ?? null,
        written: dml?.counts.written ?? null,
        unchanged: dml?.counts.unchanged ?? null,
        concurrentChange: dml?.counts['concurrent-change'] ?? null,
        notFound: dml?.counts['not-found'] ?? null,
        expressionUndefined: dml?.counts['expression-undefined'] ?? null,
        failed: dml?.counts.failed ?? null,
        notAttempted: dml?.counts['not-attempted'] ?? null,
        totalRequestCharge: dml?.totalRequestCharge ?? null,
        retry: dml ? (dml.retry ? 1 : 0) : null
      })
    return toQueryHistoryEntry(this.getRowById(id)!)
  }

  /** Most recent first (user story 50/11: "recently used"). `rowid` breaks
   * ties within the same millisecond — `executed_at` alone isn't a stable
   * sort key for two queries recorded in rapid succession. */
  list(limit: number = DEFAULT_LIST_LIMIT): QueryHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM query_history ORDER BY executed_at DESC, rowid DESC LIMIT ?')
      .all(limit) as QueryHistoryRow[]
    return rows.map(toQueryHistoryEntry)
  }

  /**
   * Search (user story 52) — a plain `LIKE` over profile name and query
   * text, not FTS5: history volumes for a local-only, single-user tool
   * don't warrant a full-text index, and `query_text` is frequently absent
   * by design (user story 53), which would leave an FTS index mostly empty
   * anyway. A DML Statement run's entry also matches by container name
   * and verb, so it is findable without its statement text.
   */
  search(term: string, limit: number = DEFAULT_LIST_LIMIT): QueryHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM query_history
         WHERE profile_name LIKE @pattern ESCAPE '\\'
            OR query_text LIKE @pattern ESCAPE '\\'
            OR container_name LIKE @pattern ESCAPE '\\'
            OR dml_verb LIKE @pattern ESCAPE '\\'
         ORDER BY executed_at DESC, rowid DESC
         LIMIT @limit`
      )
      .all({ pattern: toLikePattern(term), limit }) as QueryHistoryRow[]
    return rows.map(toQueryHistoryEntry)
  }

  /**
   * Deletes every Query History Entry (user story 53: "so that I don't
   * accidentally retain sensitive data at rest" — the opt-in's companion
   * escape hatch for a user who persisted query text and wants it gone,
   * not just future entries withheld). Whole-table delete, not a filtered
   * one: a partial purge would still leave the user guessing what remains.
   */
  clear(): void {
    this.db.exec('DELETE FROM query_history')
  }

  private getRowById(id: string): QueryHistoryRow | undefined {
    return this.db.prepare('SELECT * FROM query_history WHERE id = ?').get(id) as
      QueryHistoryRow | undefined
  }
}

/** Escapes `LIKE`'s own wildcard characters (`%`, `_`, and the escape
 * character itself) in the user's search term *before* wrapping it in the
 * `%...%` substring-match pattern, so a literal `%` or `_` typed by the
 * user searches literally rather than as a wildcard. */
function toLikePattern(term: string): string {
  const escaped = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  return `%${escaped}%`
}

function toQueryHistoryEntry(row: QueryHistoryRow): QueryHistoryEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    queryText: row.query_text ?? undefined,
    status: row.status,
    durationMs: row.duration_ms,
    rowCount: row.row_count ?? undefined,
    errorMessage: row.error_message ?? undefined,
    executedAt: row.executed_at,
    ...(row.entry_kind === 'dml' ? { dml: toDmlHistoryDetail(row) } : {})
  }
}

function toDmlHistoryDetail(row: QueryHistoryRow): DmlHistoryDetail {
  return {
    verb: row.dml_verb ?? undefined,
    databaseName: row.database_name ?? undefined,
    containerName: row.container_name ?? undefined,
    counts: {
      written: row.written_count ?? 0,
      unchanged: row.unchanged_count ?? 0,
      'concurrent-change': row.concurrent_change_count ?? 0,
      'not-found': row.not_found_count ?? 0,
      'expression-undefined': row.expression_undefined_count ?? 0,
      failed: row.failed_count ?? 0,
      'not-attempted': row.not_attempted_count ?? 0
    },
    totalRequestCharge: row.total_request_charge ?? 0,
    retry: row.is_retry === 1
  }
}
