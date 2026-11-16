import { randomUUID } from 'node:crypto'
import type { ResultChunk } from '@shared/types/database-provider'
import {
  parseDmlStatement,
  translateDmlStatement,
  translateRetry,
  type DmlOperationTemplate,
  type DmlTranslation,
  type DmlVerb,
  type DrivingQuery,
  type PartitionKeyColumns
} from '@shared/dml/dml-statement'
import type {
  ContainerTarget,
  DocumentPatchOperation,
  DocumentWrite,
  DocumentWriteResult,
  DocumentWriter,
  DrivingQueryOptions,
  PartitionKeyLevelValue,
  PartitionKeyValue
} from '@shared/types/document-writer'
import {
  DML_SAMPLE_SIZE,
  DML_WRITE_POOL_SIZE,
  emptyOutcomeCounts,
  isNotWritten,
  MAX_DML_PLAN_DOCUMENTS,
  type DmlOutcomeRow,
  type DmlPlanningProgress,
  type DmlSampleDocument,
  type DmlSampleValue,
  type WriteOutcome
} from '@shared/types/dml-run'
import { isNoneValue } from '@shared/types/document-writer'
import { toExecutionErrorMessage } from './scrub-error-message'

/** One matched document of a DML Plan: its address, the version (`_etag`)
 * the commit's Document Write is conditioned on and, for `UPDATE`, what
 * each `SET` came to. */
export interface PlannedDocument {
  id: string
  partitionKey: PartitionKeyValue
  etag: string
  /** `UPDATE` only: one per `SET`, in statement order. */
  assignments?: PlannedAssignment[]
}

/**
 * One `SET` of an `UPDATE` as Cosmos DB evaluated it for one match, from
 * the Driving Query's `__set<n>`/`__def<n>` columns. `value` is absent when
 * the expression came back undefined (Cosmos omits undefined projections).
 * `pathDefined` says whether the target path exists today.
 */
export type PlannedAssignment =
  | { op: 'set'; path: string; target: string; value?: { value: unknown }; pathDefined: boolean }
  | { op: 'remove'; path: string; target: string; pathDefined: boolean }

/** A DML Plan (GLOSSARY.md) held in Query Execution Service memory until
 * it is committed or dropped. Never persisted. */
export interface DmlPlan {
  planId: string
  profileId: string
  tabId: string
  /** The statement text as planned; a Retry's is the original's. */
  statement: string
  verb: DmlVerb
  target: ContainerTarget
  partitionKeyPaths: string[]
  documents: PlannedDocument[]
  /** The first matches with today's value of each `SET` path, for the
   * confirmation only; the commit never reads it. */
  sample: DmlSampleDocument[]
  drivingQueryRequestCharge: number
  /** Mean stored bytes per retrieved document, when query metrics came
   * back; feeds the confirmation's rough write-RU band only. */
  averageDocumentSize?: number
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

/** One document of a committed run: its address and Write Outcome. */
export interface CommittedDocument {
  id: string
  partitionKey: PartitionKeyValue
  outcome: WriteOutcome
}

/**
 * A tab's last committed run (ADR 0004 amendment, Retry): what a Retry
 * needs and nothing more, so no `SET` values or versions. `planId` is the
 * committed plan's, which `planRetry` names.
 */
export interface LastCommittedRun {
  planId: string
  profileId: string
  tabId: string
  statement: string
  target: ContainerTarget
  documents: CommittedDocument[]
}

/**
 * The last committed run of each tab. Replaced only when another run in
 * the tab commits; dropped by a plan for an ordinary statement in the tab,
 * `releaseTab` and disconnect. A Retry's planning leaves it alone.
 */
export class LastCommittedRunStore {
  private readonly runs = new Map<string, LastCommittedRun>()

  keep(run: LastCommittedRun): void {
    this.runs.set(run.tabId, run)
  }

  get(tabId: string): LastCommittedRun | undefined {
    return this.runs.get(tabId)
  }

  dropTab(tabId: string): void {
    this.runs.delete(tabId)
  }

  dropProfile(profileId: string): void {
    for (const [tabId, run] of this.runs) if (run.profileId === profileId) this.runs.delete(tabId)
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

  const partitionKeyPaths = await writer.readPartitionKeyPaths(input.target)
  const translated = translateDmlStatement(input.statement, partitionKeyPaths)
  if (!translated.ok) throw new Error(`DML syntax error: ${translated.error.message}`)
  if (run.cancelled) throw new DmlRunCancelledError()

  const matches = new MatchCollector(translated.translation, run, onProgress)
  await matches.collect(writer, translated.translation.drivingQuery, {
    ...input.target,
    executionId: input.executionId
  })
  if (matches.documents.length > MAX_DML_PLAN_DOCUMENTS) {
    throw new Error(
      `This ${shell.statement.verb} matches more than ${MAX_DML_PLAN_DOCUMENTS.toLocaleString('en-US')} ` +
        'documents, so nothing was written. Narrow your WHERE and run it again.'
    )
  }

  return matches.toPlan({
    profileId: input.profileId,
    tabId: input.tabId,
    statement: input.statement,
    verb: shell.statement.verb,
    target: input.target,
    partitionKeyPaths
  })
}

/**
 * Plans a Retry (GLOSSARY.md) of the tab's last committed run: its
 * statement's Driving Query scoped to the documents it left not written
 * (any Write Outcome but `written`/`unchanged`), chunk by chunk, so
 * `WHERE`, `SET` values and `_etag` come from current versions. Documents
 * that no longer match or were deleted drop out of the plan. Cancel stops
 * between chunks (and pages).
 */
export async function buildRetryPlan(
  writer: DocumentWriter,
  committed: LastCommittedRun,
  executionId: string,
  run: DmlRun,
  onProgress: (progress: DmlPlanningProgress) => void
): Promise<{ plan: DmlPlan; scopeCount: number }> {
  const scope = committed.documents.filter((document) => isNotWritten(document.outcome))
  const partitionKeyPaths = await writer.readPartitionKeyPaths(committed.target)
  const translated = translateRetry(committed.statement, partitionKeyPaths, scope)
  if (!translated.ok) throw new Error(`DML syntax error: ${translated.error.message}`)

  const matches = new MatchCollector(translated.translation, run, onProgress)
  for (const chunk of translated.chunks) {
    if (run.cancelled) throw new DmlRunCancelledError()
    // `IN` lists match any combination of the chunk's ids and keys: keep
    // only the exact addresses this chunk was scoped to.
    const scoped = new Set(chunk.addresses.map(addressKey))
    await matches.collect(writer, chunk.drivingQuery, { ...committed.target, executionId }, (document) =>
      scoped.has(addressKey(document))
    )
  }

  return {
    plan: matches.toPlan({
      profileId: committed.profileId,
      tabId: committed.tabId,
      statement: committed.statement,
      verb: translated.statement.verb,
      target: committed.target,
      partitionKeyPaths
    }),
    scopeCount: scope.length
  }
}

/** One address as a comparable key (JSON keeps `{}`, `null`, `1` and `"1"`
 * apart). */
function addressKey(address: { id: string; partitionKey: PartitionKeyValue }): string {
  return JSON.stringify([address.id, address.partitionKey])
}

/** Gathers a plan's matches, sample and RU from one or more Driving
 * Queries, reporting progress after each page. */
class MatchCollector {
  readonly documents: PlannedDocument[] = []
  private readonly sample: DmlSampleDocument[] = []
  private requestCharge = 0
  private retrievedDocumentCount = 0
  private retrievedDocumentSize = 0

  constructor(
    private readonly translation: DmlTranslation,
    private readonly run: DmlRun,
    private readonly onProgress: (progress: DmlPlanningProgress) => void
  ) {}

  async collect(
    writer: DocumentWriter,
    query: DrivingQuery,
    options: DrivingQueryOptions,
    keep: (document: PlannedDocument) => boolean = () => true
  ): Promise<void> {
    for await (const page of writer.runDrivingQuery(query, options)) {
      this.requestCharge += page.requestCharge
      this.retrievedDocumentCount += page.retrievedDocumentCount ?? 0
      this.retrievedDocumentSize += page.retrievedDocumentSize ?? 0
      for (const row of page.rows) {
        const document = toPlannedDocument(row, this.translation)
        if (!keep(document)) continue
        this.documents.push(document)
        if (this.sample.length < DML_SAMPLE_SIZE) {
          this.sample.push(toSampleDocument(row, document, this.translation.operations))
        }
      }
      // Leaving the loop stops the provider paging further; the caller
      // refuses past the ceiling.
      if (this.documents.length > MAX_DML_PLAN_DOCUMENTS) return
      if (this.run.cancelled) throw new DmlRunCancelledError()
      this.onProgress({ matched: this.documents.length, requestCharge: this.requestCharge })
    }
    // A cancelled query can also end quietly instead of throwing.
    if (this.run.cancelled) throw new DmlRunCancelledError()
  }

  toPlan(
    held: Pick<DmlPlan, 'profileId' | 'tabId' | 'statement' | 'verb' | 'target' | 'partitionKeyPaths'>
  ): DmlPlan {
    return {
      planId: randomUUID(),
      ...held,
      documents: this.documents,
      sample: this.sample,
      drivingQueryRequestCharge: this.requestCharge,
      ...(this.retrievedDocumentCount > 0
        ? { averageDocumentSize: this.retrievedDocumentSize / this.retrievedDocumentCount }
        : {})
    }
  }
}

/** A sampled match: its address and, for `UPDATE`, current → new per `SET`
 * (current from the Driving Query's `__cur<n>`/`__def<n>` columns). */
function toSampleDocument(
  row: unknown,
  document: PlannedDocument,
  operations: DmlOperationTemplate[]
): DmlSampleDocument {
  const match = row as Record<string, unknown>
  const sampled: DmlSampleDocument = { id: document.id, partitionKey: document.partitionKey }
  if (document.assignments) {
    sampled.changes = document.assignments.map((assignment, i) => {
      const current: DmlSampleValue =
        assignment.pathDefined && operations[i].currentColumn in match
          ? { defined: true, value: match[operations[i].currentColumn] }
          : { defined: false }
      const next: DmlSampleValue =
        assignment.op === 'set' && assignment.value
          ? { defined: true, value: assignment.value.value }
          : { defined: false }
      return { target: assignment.target, current, next }
    })
  }
  return sampled
}

function toPlannedDocument(
  row: unknown,
  translation: { partitionKey: PartitionKeyColumns[]; operations: DmlOperationTemplate[] }
): PlannedDocument {
  const match = row as Record<string, unknown>
  // `IS_DEFINED` false means the None value (`{}`), never "unknown".
  const levels = translation.partitionKey.map((key): PartitionKeyLevelValue =>
    match[key.definedColumn] === true ? (match[key.valueColumn] as PartitionKeyLevelValue) : {}
  )
  const document: PlannedDocument = {
    id: String(match.id),
    etag: String(match._etag),
    partitionKey: levels.length === 1 ? levels[0] : levels
  }
  if (translation.operations.length > 0) {
    document.assignments = translation.operations.map((template): PlannedAssignment => {
      const { path, target } = template
      const pathDefined = match[template.definedColumn] === true
      if (template.op === 'remove') return { op: 'remove', path, target, pathDefined }
      return {
        op: 'set',
        path,
        target,
        pathDefined,
        ...(template.valueColumn in match ? { value: { value: match[template.valueColumn] } } : {})
      }
    })
  }
  return document
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
 * `not-attempted`. The last chunk carries the summary. Resolves with each
 * document's address and Write Outcome, for the tab's last committed run.
 */
export async function commitDmlPlan(
  writer: DocumentWriter,
  plan: DmlPlan,
  run: DmlRun,
  sendChunk: (chunk: ResultChunk) => void
): Promise<CommittedDocument[]> {
  const startedAt = Date.now()
  const total = plan.documents.length
  const counts = emptyOutcomeCounts()
  const columns = plan.partitionKeyPaths.map(partitionKeyColumnName)
  let writeRequestCharge = 0
  let completed = 0
  let buffer: DmlOutcomeRow[] = []
  let bufferRequestCharge = 0
  let lastSentAt = startedAt
  const committed: CommittedDocument[] = []

  const progressChunk = (): ResultChunk => ({
    rows: buffer,
    meta: {
      ru: bufferRequestCharge,
      dmlProgress: { completed, total, requestCharge: writeRequestCharge, counts: { ...counts } }
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
    committed.push({ id: document.id, partitionKey: document.partitionKey, outcome })
    writeRequestCharge += requestCharge
    bufferRequestCharge += requestCharge
    buffer.push(outcomeRow(document, columns, outcome, requestCharge, message))
  }

  let next = 0
  const worker = async (): Promise<void> => {
    while (!run.cancelled && next < total) {
      const document = plan.documents[next++]
      const [outcome, requestCharge, message] =
        plan.verb === 'DELETE'
          ? await deleteOne(writer, plan, document)
          : await updateOne(writer, plan, document)
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
  return committed
}

const CONCURRENT_CHANGE_MESSAGE = 'This document changed after the DML Plan was made, so it was skipped.'
const UNEXPECTED_CONFLICT_MESSAGE = 'Cosmos DB reported an unexpected conflict.'

async function deleteOne(
  writer: DocumentWriter,
  plan: DmlPlan,
  document: PlannedDocument
): Promise<[WriteOutcome, number, string]> {
  const result = await send(writer, {
    kind: 'delete',
    id: document.id,
    partitionKey: document.partitionKey,
    ifMatch: document.etag,
    ...plan.target
  })
  if ('failed' in result) return ['failed', 0, result.failed]
  switch (result.outcome) {
    case 'success':
      return ['written', result.requestCharge, '']
    case 'not-found':
      // The outcome the user wanted: counted as written (story 107).
      return ['written', result.requestCharge, 'This document was already deleted.']
    case 'precondition-failed':
      return ['concurrent-change', result.requestCharge, CONCURRENT_CHANGE_MESSAGE]
    case 'conflict':
      return ['failed', result.requestCharge, UNEXPECTED_CONFLICT_MESSAGE]
  }
}

async function updateOne(
  writer: DocumentWriter,
  plan: DmlPlan,
  document: PlannedDocument
): Promise<[WriteOutcome, number, string]> {
  const assignments = document.assignments ?? []
  // Story 106: a bad expression never removes data by surprise.
  const undefinedSets = assignments.filter((a) => a.op === 'set' && !a.value)
  if (undefinedSets.length > 0) {
    const targets = undefinedSets.map((a) => a.target).join(', ')
    return [
      'expression-undefined',
      0,
      `SET ${targets} came back undefined for this document, so nothing was sent. ` +
        'Use SET <path> = undefined to remove a property.'
    ]
  }
  const operations: DocumentPatchOperation[] = []
  for (const assignment of assignments) {
    if (assignment.op === 'set') {
      operations.push({ op: 'set', path: assignment.path, value: assignment.value?.value })
    } else if (assignment.pathDefined) {
      // A remove of an already-absent path would fail the whole patch (400).
      operations.push({ op: 'remove', path: assignment.path })
    }
  }
  if (operations.length === 0) {
    return ['unchanged', 0, 'Only removed paths that were already absent, so nothing was sent.']
  }
  const result = await send(writer, {
    kind: 'patch',
    id: document.id,
    partitionKey: document.partitionKey,
    ifMatch: document.etag,
    operations,
    ...plan.target
  })
  if ('failed' in result) return ['failed', 0, result.failed]
  switch (result.outcome) {
    case 'success':
      // The patched document came back too; it is dropped, never sent on.
      return ['written', result.requestCharge, '']
    case 'not-found':
      return ['not-found', result.requestCharge, 'This document was deleted after the DML Plan was made.']
    case 'precondition-failed':
      return ['concurrent-change', result.requestCharge, CONCURRENT_CHANGE_MESSAGE]
    case 'conflict':
      return ['failed', result.requestCharge, UNEXPECTED_CONFLICT_MESSAGE]
  }
}

/** Sends one low-priority Document Write; a thrown error comes back as its
 * scrubbed message. */
async function send(
  writer: DocumentWriter,
  write: DocumentWrite
): Promise<DocumentWriteResult | { failed: string }> {
  try {
    return await writer.writeDocument(write, { priorityLevel: 'Low' })
  } catch (err) {
    return { failed: toExecutionErrorMessage(err) }
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
    if (!isNoneValue(level)) row[column] = level
  })
  return { ...row, id: document.id, outcome, requestCharge, message }
}
