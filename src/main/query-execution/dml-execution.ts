import { randomUUID } from 'node:crypto'
import type { ResultChunk } from '@shared/types/database-provider'
import {
  parseDmlStatement,
  translateDmlStatement,
  type DmlVerb,
  type PartitionKeyColumns
} from '@shared/dml/dml-statement'
import type {
  ContainerTarget,
  DocumentWriteResult,
  DocumentWriter,
  PartitionKeyLevelValue,
  PartitionKeyValue
} from '@shared/types/document-writer'
import {
  DML_WRITE_POOL_SIZE,
  emptyOutcomeCounts,
  MAX_DML_PLAN_DOCUMENTS,
  type DmlOutcomeRow,
  type DmlPlanningProgress,
  type WriteOutcome
} from '@shared/types/dml-run'
import { toExecutionErrorMessage } from './scrub-error-message'

/** One matched document of a DML Plan: its address and the version
 * (`_etag`) the commit's Document Write is conditioned on. */
export interface PlannedDocument {
  id: string
  partitionKey: PartitionKeyValue
  etag: string
}

/** A DML Plan (GLOSSARY.md) held in Query Execution Service memory until
 * it is committed or dropped. Never persisted. */
export interface DmlPlan {
  planId: string
  profileId: string
  tabId: string
  verb: DmlVerb
  target: ContainerTarget
  partitionKeyPaths: string[]
  documents: PlannedDocument[]
  drivingQueryRequestCharge: number
}

/** A planning or commit run, addressable by its Execution ID for cancel. */
export interface DmlRun {
  cancelled: boolean
}

export class DmlRunCancelledError extends Error {
  constructor() {
    super('The DML Statement run was cancelled.')
    this.name = 'DmlRunCancelledError'
  }
}

/**
 * The held DML Plans, at most one per tab (ADR 0004 amendment, Tab
 * identity). Dropped on `discardPlan`, a new plan in the same tab,
 * `releaseTab`, disconnect, and when committed. No time-based expiry.
 */
export class DmlPlanStore {
  private readonly plans = new Map<string, DmlPlan>()

  hold(plan: DmlPlan): void {
    this.dropTab(plan.tabId)
    this.plans.set(plan.planId, plan)
  }

  get(planId: string): DmlPlan | undefined {
    return this.plans.get(planId)
  }

  drop(planId: string): void {
    this.plans.delete(planId)
  }

  dropTab(tabId: string): void {
    this.dropWhere((plan) => plan.tabId === tabId)
  }

  dropProfile(profileId: string): void {
    this.dropWhere((plan) => plan.profileId === profileId)
  }

  private dropWhere(predicate: (plan: DmlPlan) => boolean): void {
    for (const [planId, plan] of this.plans) if (predicate(plan)) this.plans.delete(planId)
  }
}

export interface PlanDmlInput {
  profileId: string
  tabId: string
  executionId: string
  statement: string
  target: ContainerTarget
}

/**
 * Re-parses the statement (the authority, story 144), runs its Driving
 * Query to the end and returns the DML Plan. Refuses a syntax error before
 * anything is sent and refuses past the ceiling before any write.
 */
export async function buildDmlPlan(
  writer: DocumentWriter,
  input: PlanDmlInput,
  run: DmlRun,
  onProgress: (progress: DmlPlanningProgress) => void
): Promise<DmlPlan> {
  // A syntax error needs no container definition, so it costs nothing.
  const shell = parseDmlStatement(input.statement)
  if (!shell.ok) throw new Error(`DML syntax error: ${shell.error.message}`)
  if (shell.statement.verb === 'UPDATE') {
    throw new Error('UPDATE statements are not supported yet. Only DELETE can run for now.')
  }

  const partitionKeyPaths = await writer.readPartitionKeyPaths(input.target)
  const translated = translateDmlStatement(input.statement, partitionKeyPaths)
  if (!translated.ok) throw new Error(`DML syntax error: ${translated.error.message}`)
  if (run.cancelled) throw new DmlRunCancelledError()

  const documents: PlannedDocument[] = []
  let requestCharge = 0
  for await (const page of writer.runDrivingQuery(translated.translation.drivingQuery, {
    ...input.target,
    executionId: input.executionId
  })) {
    requestCharge += page.requestCharge
    for (const row of page.rows) {
      documents.push(toPlannedDocument(row, translated.translation.partitionKey))
    }
    // Throwing leaves the loop, which stops the provider paging further.
    if (documents.length > MAX_DML_PLAN_DOCUMENTS) {
      throw new Error(
        `This ${shell.statement.verb} matches more than ${MAX_DML_PLAN_DOCUMENTS.toLocaleString('en-US')} ` +
          'documents, so nothing was written. Narrow your WHERE and run it again.'
      )
    }
    if (run.cancelled) throw new DmlRunCancelledError()
    onProgress({ matched: documents.length, requestCharge })
  }
  // A cancelled query can also end quietly instead of throwing.
  if (run.cancelled) throw new DmlRunCancelledError()

  return {
    planId: randomUUID(),
    profileId: input.profileId,
    tabId: input.tabId,
    verb: shell.statement.verb,
    target: input.target,
    partitionKeyPaths,
    documents,
    drivingQueryRequestCharge: requestCharge
  }
}

function toPlannedDocument(row: unknown, partitionKey: PartitionKeyColumns[]): PlannedDocument {
  const match = row as Record<string, unknown>
  // `IS_DEFINED` false means the None value (`{}`), never "unknown".
  const levels = partitionKey.map((key): PartitionKeyLevelValue =>
    match[key.definedColumn] === true ? (match[key.valueColumn] as PartitionKeyLevelValue) : {}
  )
  return {
    id: String(match.id),
    etag: String(match._etag),
    partitionKey: levels.length === 1 ? levels[0] : levels
  }
}

/** Rows buffered before a chunk is sent, and the longest a completed
 * outcome waits before its chunk goes out. */
const CHUNK_ROWS = 100
const CHUNK_INTERVAL_MS = 250

const OUTCOME_COLUMNS = new Set(['id', 'outcome', 'requestCharge', 'message'])

/**
 * Writes exactly the DML Plan: one point Document Write per document from
 * a pool of `DML_WRITE_POOL_SIZE`, streaming one Write Outcome row per
 * document in completion order. On cancel it stops dispatching, lets
 * in-flight writes report real outcomes and marks the rest
 * `not-attempted`. The last chunk carries the summary.
 */
export async function commitDmlPlan(
  writer: DocumentWriter,
  plan: DmlPlan,
  run: DmlRun,
  sendChunk: (chunk: ResultChunk) => void
): Promise<void> {
  const startedAt = Date.now()
  const total = plan.documents.length
  const counts = emptyOutcomeCounts()
  const columns = plan.partitionKeyPaths.map(partitionKeyColumnName)
  let writeRequestCharge = 0
  let completed = 0
  let buffer: DmlOutcomeRow[] = []
  let bufferRequestCharge = 0
  let lastSentAt = startedAt

  const progressChunk = (): ResultChunk => ({
    rows: buffer,
    meta: {
      ru: bufferRequestCharge,
      dmlProgress: { completed, total, requestCharge: writeRequestCharge }
    }
  })
  const flush = (): void => {
    sendChunk(progressChunk())
    buffer = []
    bufferRequestCharge = 0
    lastSentAt = Date.now()
  }
  const record = (
    document: PlannedDocument,
    outcome: WriteOutcome,
    requestCharge: number,
    message: string
  ): void => {
    counts[outcome]++
    completed++
    writeRequestCharge += requestCharge
    bufferRequestCharge += requestCharge
    buffer.push(outcomeRow(document, columns, outcome, requestCharge, message))
  }

  let next = 0
  const worker = async (): Promise<void> => {
    while (!run.cancelled && next < total) {
      const document = plan.documents[next++]
      const [outcome, requestCharge, message] = await deleteOne(writer, plan, document)
      record(document, outcome, requestCharge, message)
      if (buffer.length >= CHUNK_ROWS || Date.now() - lastSentAt >= CHUNK_INTERVAL_MS) flush()
    }
  }
  await Promise.all(Array.from({ length: Math.min(DML_WRITE_POOL_SIZE, total) }, worker))

  for (const document of plan.documents.slice(next)) {
    record(document, 'not-attempted', 0, 'The run was stopped before this write was sent.')
  }

  const last = progressChunk()
  sendChunk({
    ...last,
    meta: {
      ...last.meta,
      dmlSummary: {
        verb: plan.verb,
        counts,
        drivingQueryRequestCharge: plan.drivingQueryRequestCharge,
        writeRequestCharge,
        durationMs: Date.now() - startedAt,
        cancelled: run.cancelled
      }
    }
  })
}

async function deleteOne(
  writer: DocumentWriter,
  plan: DmlPlan,
  document: PlannedDocument
): Promise<[WriteOutcome, number, string]> {
  let result: DocumentWriteResult
  try {
    result = await writer.writeDocument(
      {
        kind: 'delete',
        id: document.id,
        partitionKey: document.partitionKey,
        ifMatch: document.etag,
        ...plan.target
      },
      { priorityLevel: 'Low' }
    )
  } catch (err) {
    return ['failed', 0, toExecutionErrorMessage(err)]
  }
  switch (result.outcome) {
    case 'success':
      return ['written', result.requestCharge, '']
    case 'not-found':
      // The outcome the user wanted: counted as written (story 107).
      return ['written', result.requestCharge, 'This document was already deleted.']
    case 'precondition-failed':
      return [
        'concurrent-change',
        result.requestCharge,
        'This document changed after the DML Plan was made, so it was skipped.'
      ]
    case 'conflict':
      return ['failed', result.requestCharge, 'Cosmos DB reported an unexpected conflict.']
  }
}

/** A partition key path as an outcome row column (`/customerId` →
 * `customerId`), keeping the leading `/` if it would collide with one of
 * the fixed columns. */
function partitionKeyColumnName(path: string): string {
  const name = path.replace(/^\//, '')
  return OUTCOME_COLUMNS.has(name) ? path : name
}

function outcomeRow(
  document: PlannedDocument,
  columns: string[],
  outcome: WriteOutcome,
  requestCharge: number,
  message: string
): DmlOutcomeRow {
  const levels = columns.length === 1 ? [document.partitionKey] : (document.partitionKey as unknown[])
  const row: Record<string, unknown> = { id: document.id }
  columns.forEach((column, i) => {
    const level = levels[i]
    // The None value (`{}`) leaves the column empty: the document has no
    // such property.
    if (!(level !== null && typeof level === 'object')) row[column] = level
  })
  return { ...row, id: document.id, outcome, requestCharge, message }
}
