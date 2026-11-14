import { isRecord } from '@shared/is-record'
import type {
  DocumentWrite,
  PartitionKeyLevelValue,
  PartitionKeyValue,
  StoredDocument
} from '@shared/types/document-writer'
import {
  isOutOfDate,
  partitionKeyFieldName,
  partitionKeyPathSegments,
  readPath,
  sameAddress,
  type DocumentAddress
} from './addressable-row'

/** The server-managed properties shown read-only and never sent back. */
export const SYSTEM_PROPERTIES = ['_rid', '_self', '_etag', '_attachments', '_ts'] as const

/** Where an edit session's Document Writes go: the Connection Profile and the
 * container the row came from (captured at Run time, not the tab's current
 * Container picker value). */
export interface DocumentTarget {
  connectionId: string
  database?: string
  container?: string
}

export type EditSessionPhase = 'reading' | 'missing' | 'out-of-date' | 'read-failed' | 'editing'

/**
 * One document open in the drawer (spec "Edit session (renderer)"): the
 * address, the etag (from the point-read, then from each successful save),
 * the server copy, the draft body text and the current notice. The `_etag`
 * inside the draft is never used for concurrency.
 */
export interface EditSession {
  key: number
  target: DocumentTarget
  partitionKeyPaths: readonly string[]
  address: DocumentAddress
  /** The grid row's `_rid`, if it carried one (the `_rid` guard). */
  rowRid: string | undefined
  phase: EditSessionPhase
  serverCopy: StoredDocument | undefined
  etag: string | undefined
  /** The editor's text: the body without `id`, partition key fields or
   * system properties. */
  draft: string
  /** Bumped whenever `draft` is replaced from the server copy, so a mounted
   * editor knows to reload its text. */
  revision: number
  /** A Document Write is in flight. */
  saving: boolean
  notice: EditNotice | undefined
  /** Set while this is a New document session (until its create succeeds):
   * the `id` and partition key fields as typed. `address` is then the
   * prefill or the last create attempt, not a stored document. */
  newDocument?: NewDocumentFields
}

/** New document's editable address fields: the `id`, and one partition key
 * field per level (see `parsePartitionKeyInput`). */
export interface NewDocumentFields {
  id: string
  partitionKey: string[]
}

/** What the drawer shows above the editor. */
export type EditNotice =
  | { kind: 'saved'; requestCharge: number }
  /** Save refused: the draft changes `id` or a partition key field. */
  | { kind: 'address-changed'; fields: string[] }
  /** Save refused: the draft isn't a JSON object. */
  | { kind: 'invalid-body'; message: string }
  /** Create refused: New document's address fields are empty or disagree
   * with the body. */
  | { kind: 'invalid-address'; message: string }
  /** The etag no longer matches: someone else changed the document. */
  | { kind: 'concurrent-change' }
  | { kind: 'deleted-while-editing' }
  | { kind: 'error'; message: string }

export type EditSessionEvent =
  | { type: 'readSucceeded'; document: StoredDocument }
  | { type: 'readNotFound' }
  | { type: 'readFailed'; message: string }
  | { type: 'draftChanged'; text: string }
  /** New document's `id` / partition key fields were edited. */
  | { type: 'newDocumentFieldsChanged'; fields: NewDocumentFields }
  | { type: 'saveRefused'; notice: EditNotice }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; document: StoredDocument; requestCharge: number }
  | {
      type: 'saveOutcome'
      outcome: 'precondition-failed' | 'not-found' | 'conflict'
      requestCharge: number
    }
  | { type: 'saveFailed'; message: string }

export function openEditSession(input: {
  key: number
  target: DocumentTarget
  partitionKeyPaths: readonly string[]
  address: DocumentAddress
  row: unknown
}): EditSession {
  return {
    key: input.key,
    target: input.target,
    partitionKeyPaths: input.partitionKeyPaths,
    address: input.address,
    rowRid: isRecord(input.row) && typeof input.row._rid === 'string' ? input.row._rid : undefined,
    phase: 'reading',
    serverCopy: undefined,
    etag: undefined,
    draft: '',
    revision: 0,
    saving: false,
    notice: undefined
  }
}

/** A New document session (stories 4, 26): editable `id` and partition key
 * fields above the body. */
export function openNewDocumentSession(input: {
  key: number
  target: DocumentTarget
  partitionKeyPaths: readonly string[]
  from?: EditSession
}): EditSession {
  return {
    key: input.key,
    target: input.target,
    partitionKeyPaths: input.partitionKeyPaths,
    address: { id: '', partitionKey: null },
    rowRid: undefined,
    phase: 'editing',
    serverCopy: undefined,
    etag: undefined,
    draft: '{}',
    revision: 0,
    saving: false,
    notice: undefined,
    newDocument: { id: '', partitionKey: input.partitionKeyPaths.map(() => '') }
  }
}

export function editSessionReducer(session: EditSession, event: EditSessionEvent): EditSession {
  switch (event.type) {
    case 'readSucceeded':
      if (isOutOfDate({ _rid: session.rowRid }, event.document)) {
        return { ...session, phase: 'out-of-date' }
      }
      return {
        ...session,
        phase: 'editing',
        serverCopy: event.document,
        etag: etagOf(event.document),
        draft: editorText(event.document, session.partitionKeyPaths),
        revision: session.revision + 1
      }
    case 'readNotFound':
      return { ...session, phase: 'missing' }
    case 'readFailed':
      return { ...session, phase: 'read-failed', notice: { kind: 'error', message: event.message } }
    case 'draftChanged':
      return { ...session, draft: event.text }
    case 'newDocumentFieldsChanged':
      return session.newDocument ? { ...session, newDocument: event.fields } : session
    case 'saveRefused':
      return { ...session, saving: false, notice: event.notice }
    case 'saveStarted':
      return { ...session, saving: true, notice: undefined }
    case 'saveSucceeded':
      return {
        ...session,
        saving: false,
        serverCopy: event.document,
        etag: etagOf(event.document),
        draft: editorText(event.document, session.partitionKeyPaths),
        revision: session.revision + 1,
        notice: { kind: 'saved', requestCharge: event.requestCharge }
      }
    case 'saveOutcome':
      return { ...session, saving: false, notice: noticeForOutcome(event.outcome) }
    case 'saveFailed':
      return { ...session, saving: false, notice: { kind: 'error', message: event.message } }
  }
}

/** Every edit session of one query tab's results; several show as tabs
 * across the top of the drawer. */
export interface EditSessionsState {
  sessions: EditSession[]
  activeKey: number | undefined
}

export const initialEditSessionsState: EditSessionsState = { sessions: [], activeKey: undefined }

export type EditSessionsAction =
  | {
      type: 'opened'
      key: number
      target: DocumentTarget
      partitionKeyPaths: readonly string[]
      address: DocumentAddress
      row: unknown
    }
  /** New document, empty, or prefilled from the edit session `from`
   * ("Different address? New document"). */
  | {
      type: 'newDocumentOpened'
      key: number
      target: DocumentTarget
      partitionKeyPaths: readonly string[]
      from?: number
    }
  | { type: 'selected'; key: number }
  | { type: 'closed'; key: number }
  | { type: 'session'; key: number; event: EditSessionEvent }

export function editSessionsReducer(
  state: EditSessionsState,
  action: EditSessionsAction
): EditSessionsState {
  switch (action.type) {
    case 'opened': {
      const existing = findEditSession(state, action.target, action.address)
      if (existing) return { ...state, activeKey: existing.key }
      return { sessions: [...state.sessions, openEditSession(action)], activeKey: action.key }
    }
    case 'newDocumentOpened': {
      const from = state.sessions.find((s) => s.key === action.from)
      return {
        sessions: [...state.sessions, openNewDocumentSession({ ...action, from })],
        activeKey: action.key
      }
    }
    case 'selected':
      return state.sessions.some((s) => s.key === action.key) ? { ...state, activeKey: action.key } : state
    case 'closed': {
      const sessions = state.sessions.filter((s) => s.key !== action.key)
      const activeKey =
        state.activeKey === action.key ? sessions[sessions.length - 1]?.key : state.activeKey
      return { sessions, activeKey }
    }
    case 'session': {
      if (!state.sessions.some((s) => s.key === action.key)) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.key === action.key ? editSessionReducer(s, action.event) : s
        )
      }
    }
  }
}

/** The edit session already open on this document, if any. */
export function findEditSession(
  state: EditSessionsState,
  target: DocumentTarget,
  address: DocumentAddress
): EditSession | undefined {
  return state.sessions.find((s) => sameTarget(s.target, target) && sameAddress(s.address, address))
}

export function sameTarget(a: DocumentTarget | undefined, b: DocumentTarget | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.connectionId === b.connectionId &&
    a.database === b.database &&
    a.container === b.container
  )
}

export type SavePlan = { ok: true; write: DocumentWrite } | { ok: false; notice: EditNotice }

/**
 * What Save sends for this session: a `replace` carrying the session's
 * etag (never the `_etag` typed into the draft), with system properties
 * stripped and `id` / partition key values restored from the locked
 * address. Refused when the draft isn't a JSON object or changes the
 * address (moving a document is New document's job).
 */
export function planSave(session: EditSession): SavePlan {
  if (session.newDocument) return planCreate(session, session.newDocument)
  if (session.phase !== 'editing' || session.etag === undefined) {
    return { ok: false, notice: { kind: 'error', message: 'The document has not been read yet.' } }
  }
  const parsed = parseDraft(session.draft)
  if (!parsed.ok) return parsed

  const { address, partitionKeyPaths } = session
  const body = parsed.body
  const changed: string[] = []
  if (Object.hasOwn(body, 'id') && body.id !== address.id) changed.push('id')

  const levels = partitionKeyLevels(address.partitionKey, partitionKeyPaths.length)
  partitionKeyPaths.forEach((path, i) => {
    const segments = partitionKeyPathSegments(path)
    const read = readPath(body, segments)
    const level = levels[i]
    const restored = isNoneValue(level) ? !read.found : read.found ? read.value === level : setPath(body, segments, level)
    if (!restored) changed.push(partitionKeyFieldName(path))
  })
  if (changed.length > 0) return { ok: false, notice: { kind: 'address-changed', fields: changed } }

  return {
    ok: true,
    write: {
      kind: 'replace',
      id: address.id,
      partitionKey: address.partitionKey,
      ifMatch: session.etag,
      body: { ...body, id: address.id },
      database: session.target.database,
      container: session.target.container
    }
  }
}

/** The draft as a body to send: a JSON object, system properties stripped. */
function parseDraft(
  draft: string
): { ok: true; body: Record<string, unknown> } | { ok: false; notice: EditNotice } {
  let parsed: unknown
  try {
    parsed = JSON.parse(draft)
  } catch (err) {
    return { ok: false, notice: { kind: 'invalid-body', message: (err as Error).message } }
  }
  if (!isRecord(parsed)) {
    return { ok: false, notice: { kind: 'invalid-body', message: 'A document must be a JSON object.' } }
  }
  return { ok: true, body: stripSystemProperties(parsed) }
}

/**
 * What Create sends for a New document session: a `create` with the `id`
 * and partition key value from the fields, both also written into the body
 * (the SDK takes the partition key from the body, and invents an `id` when
 * the body has none). Refused when a field is empty or the body already
 * holds a different value for it.
 */
function planCreate(session: EditSession, fields: NewDocumentFields): SavePlan {
  const { partitionKeyPaths } = session
  const empty: string[] = []
  if (fields.id === '') empty.push('id')
  partitionKeyPaths.forEach((path, i) => {
    if ((fields.partitionKey[i] ?? '') === '') empty.push(partitionKeyFieldName(path))
  })
  if (empty.length > 0) {
    return invalidAddress(`Enter ${empty.join(' and ')} for the new document.`)
  }

  const parsed = parseDraft(session.draft)
  if (!parsed.ok) return parsed
  const body = parsed.body

  const differs: string[] = []
  if (Object.hasOwn(body, 'id') && body.id !== fields.id) differs.push('id')
  const levels = partitionKeyPaths.map((_path, i) => parsePartitionKeyInput(fields.partitionKey[i]))
  partitionKeyPaths.forEach((path, i) => {
    const segments = partitionKeyPathSegments(path)
    const read = readPath(body, segments)
    const agrees = read.found ? read.value === levels[i] : setPath(body, segments, levels[i])
    if (!agrees) differs.push(partitionKeyFieldName(path))
  })
  if (differs.length > 0) {
    return invalidAddress(
      `The body's ${differs.join(' and ')} ${differs.length === 1 ? 'differs' : 'differ'} from the field above. Remove it from the body or make them match.`
    )
  }

  return {
    ok: true,
    write: {
      kind: 'create',
      id: fields.id,
      partitionKey: levels.length === 1 ? levels[0] : levels,
      body: { ...body, id: fields.id },
      database: session.target.database,
      container: session.target.container
    }
  }
}

function invalidAddress(message: string): SavePlan {
  return { ok: false, notice: { kind: 'invalid-address', message } }
}

/**
 * A New document partition key field as a value: a JSON scalar literal
 * (`72712`, `"72712"`, `true`, `null`) is that value; any other text is a
 * string as typed.
 */
export function parsePartitionKeyInput(text: string): Exclude<PartitionKeyLevelValue, Record<string, never>> {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      return value as string | number | boolean | null
    }
  } catch {
    // Not JSON: plain text.
  }
  return text
}

function partitionKeyLevels(value: PartitionKeyValue, pathCount: number): PartitionKeyLevelValue[] {
  return pathCount > 1 && Array.isArray(value) ? value : [value as PartitionKeyLevelValue]
}

/** `{}`: the document has no such partition key property. */
function isNoneValue(level: PartitionKeyLevelValue): boolean {
  return isRecord(level)
}

/** Writes a nested property, creating missing parents; false when a parent
 * exists but isn't an object. */
function setPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): boolean {
  let current = target
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(current, segment)) current[segment] = {}
    const next = current[segment]
    if (!isRecord(next)) return false
    current = next
  }
  current[segments[segments.length - 1]] = value
  return true
}

/** Concurrent Change handling beyond the notice (Compare, Reload, Save as
 * new document) is ticket 18. */
function noticeForOutcome(outcome: 'precondition-failed' | 'not-found' | 'conflict'): EditNotice {
  switch (outcome) {
    case 'precondition-failed':
      return { kind: 'concurrent-change' }
    case 'not-found':
      return { kind: 'deleted-while-editing' }
    case 'conflict':
      return { kind: 'error', message: 'The server refused the write as an id clash.' }
  }
}

/** True when the draft differs from the server copy's editor text. */
export function hasUnsavedEdits(session: EditSession): boolean {
  return (
    session.serverCopy !== undefined &&
    session.draft !== editorText(session.serverCopy, session.partitionKeyPaths)
  )
}

function etagOf(document: StoredDocument): string | undefined {
  return typeof document._etag === 'string' ? document._etag : undefined
}

/** The editor's text for a document: its body without `id`, partition key
 * fields (shown as locked chips) or system properties. */
export function editorText(document: StoredDocument, partitionKeyPaths: readonly string[]): string {
  const body = structuredClone(stripSystemProperties(document))
  delete body.id
  for (const path of partitionKeyPaths) removePath(body, partitionKeyPathSegments(path))
  return JSON.stringify(body, null, 2)
}

export function stripSystemProperties(document: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document).filter(
      ([key]) => !(SYSTEM_PROPERTIES as readonly string[]).includes(key)
    )
  )
}

function removePath(value: Record<string, unknown>, segments: readonly string[]): void {
  let current: unknown = value
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current)) return
    current = current[segment]
  }
  if (isRecord(current)) delete current[segments[segments.length - 1]]
}
