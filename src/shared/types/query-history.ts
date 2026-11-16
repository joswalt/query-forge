import type { DmlVerb } from '../dml/dml-statement'
import type { WriteOutcome } from './dml-run'

/** `partial`: a DML Statement commit ran to the end but left some
 * documents unwritten (a Write Outcome other than `written`/`unchanged`,
 * ignoring `not-attempted`). */
export type QueryHistoryStatus = 'success' | 'partial' | 'error' | 'cancelled'

/**
 * What a DML Statement run's Query History Entry keeps beyond a query's,
 * regardless of the query-text opt-in. Never document ids, per-document
 * messages or bodies.
 */
export interface DmlHistoryDetail {
  /** Absent only if the statement text didn't start with `DELETE`/`UPDATE`
   * (the renderer only plans DML Statements, so in practice always set). */
  verb: DmlVerb | undefined
  databaseName: string | undefined
  containerName: string | undefined
  /** Documents per Write Outcome; all zero when no commit ran. */
  counts: Record<WriteOutcome, number>
  /** Driving Query RU plus write RU. */
  totalRequestCharge: number
  /** The run was a Retry of an earlier run (set by the Retry slice). */
  retry: boolean
}

/**
 * A Query History Entry (GLOSSARY.md) as exposed to the renderer — shared
 * so the preload bridge and the renderer's history UI both type against
 * the same shape the Local Storage Service's `QueryHistoryRepository`
 * returns, mirroring `ConnectionProfile`'s placement in this directory.
 */
export interface QueryHistoryEntry {
  id: string
  profileId: string
  profileName: string
  /** Present only when Preferences opted into persisting query text (user
   * story 53) — withheld by default. */
  queryText: string | undefined
  status: QueryHistoryStatus
  durationMs: number
  /** For a DML entry, the documents matched (DML Plan size). */
  rowCount: number | undefined
  errorMessage: string | undefined
  executedAt: string
  /** Present only on a DML Statement run's entry. */
  dml?: DmlHistoryDetail
}
