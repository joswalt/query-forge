import type { DmlVerb } from '@shared/dml/dml-statement'
import type { DmlCommitProgress } from '@shared/types/dml-run'

/**
 * RU estimation for a DML Statement run (spec "RU estimation (renderer
 * arithmetic)", decision 09). No pre-execution estimate API exists, so
 * before any write there is only a rough band from Microsoft's published
 * anchors; once writes report, their measured charges project the rest.
 */

/** About 5.5 RU to insert a 1 KB document without indexing. */
const RU_PER_KB_INSERT = 5.5

/** Replace (and so patch, which saves no significant RU) costs about twice
 * an insert. Delete has no published figure; it is taken as an insert. */
const VERB_FACTOR: Record<DmlVerb, number> = { DELETE: 1, UPDATE: 2 }

/** The anchor is for an unindexed container. The default indexing policy
 * indexes every path, which can cost several times that, so the band's top
 * is this multiple of the anchor. */
const INDEXING_FACTOR = 4

/** Writes report their charges for this many documents before a
 * projection is shown (story 98). */
export const PROJECTION_MIN_WRITES = 8

/**
 * The rough write-RU band for a DML Plan: per document about 5.5 RU per KB
 * of the average document size (at least 1 KB), doubled for `UPDATE`, from
 * that anchor up to `INDEXING_FACTOR` times it. Undefined without an
 * average document size (no query metrics came back).
 */
export function writeRequestChargeBand(plan: {
  verb: DmlVerb
  matchCount: number
  averageDocumentSize?: number
}): { low: number; high: number } | undefined {
  if (plan.averageDocumentSize === undefined) return undefined
  const kilobytes = Math.max(1, plan.averageDocumentSize / 1024)
  const low = RU_PER_KB_INSERT * kilobytes * VERB_FACTOR[plan.verb] * plan.matchCount
  return { low, high: low * INDEXING_FACTOR }
}

/**
 * The projected total RU of a commit in progress: the running total (the
 * Driving Query's RU plus every write so far) plus the documents still to
 * come at the mean RU per write so far. Undefined until
 * `PROJECTION_MIN_WRITES` writes have reported.
 */
export function projectedRequestCharge(commit: {
  drivingQueryRequestCharge: number
  progress: DmlCommitProgress
}): number | undefined {
  const { completed, total, requestCharge } = commit.progress
  if (completed < PROJECTION_MIN_WRITES) return undefined
  const runningTotal = commit.drivingQueryRequestCharge + requestCharge
  const meanPerWrite = requestCharge / completed
  return runningTotal + Math.max(0, total - completed) * meanPerWrite
}
