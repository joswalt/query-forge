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

/** What the drawer offers for the document: editing its body, or a
 * read-only preview with an explicit Delete document button. Both start
 * from a fresh point-read. */
export type EditSessionMode = 'edit' | 'delete'

/** `editing`: the server copy is loaded (editable in edit mode, previewed
 * in delete mode). `deleted`: the delete is done; the session leaves the
 * drawer at once. */
export type EditSessionPhase =
  | 'reading'
  | 'missing'
  | 'out-of-date'
  | 'read-failed'
  | 'editing'
  | 'deleted'

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
  mode: EditSessionMode
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
}

/** What the drawer shows above the editor. */
export type EditNotice =
  | { kind: 'saved'; requestCharge: number }
  /** Save refused: the draft changes `id` or a partition key field. */
  | { kind: 'address-changed'; fields: string[] }
  /** Save refused: the draft isn't a JSON object. */
  | { kind: 'invalid-body'; message: string }
  /** The etag no longer matches: someone else changed the document. */
  | { kind: 'concurrent-change' }
  | { kind: 'deleted-while-editing' }
  /** Delete aborted: the document changed since it was read. Only Review
   * current version follows; there is no delete anyway. */
  | { kind: 'concurrent-change-on-delete' }
  /** Delete done (phase `deleted`); `alreadyDeleted` for a 404. */
  | { kind: 'deleted'; requestCharge: number; alreadyDeleted: boolean }
  | { kind: 'error'; message: string }

export type EditSessionEvent =
  | { type: 'readSucceeded'; document: StoredDocument }
  | { type: 'readNotFound' }
  | { type: 'readFailed'; message: string }
  | { type: 'draftChanged'; text: string }
  | { type: 'saveRefused'; notice: EditNotice }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; document: StoredDocument; requestCharge: number }
  | {
      type: 'saveOutcome'
      outcome: 'precondition-failed' | 'not-found' | 'conflict'
      requestCharge: number
    }
  | { type: 'saveFailed'; message: string }
  | { type: 'deleteStarted' }
  | { type: 'deleteSucceeded'; requestCharge: number }
  | { type: 'deleteOutcome'; outcome: 'precondition-failed' | 'not-found'; requestCharge: number }
  | { type: 'deleteFailed'; message: string }
  /** Review current version, after a Concurrent Change on Delete: read the
   * document again. */
  | { type: 'reviewRequested' }
  /** Delete document… on a document already open: a Delete always starts
   * from a fresh point-read, so read it again. */
  | { type: 'deleteRequested' }
  /** Edit instead (or Edit document… on an open Delete): edit the version
   * already read. */
  | { type: 'editRequested' }

export function openEditSession(input: {
  key: number
  target: DocumentTarget
  partitionKeyPaths: readonly string[]
  address: DocumentAddress
  row: unknown
  mode?: EditSessionMode
}): EditSession {
  return {
    key: input.key,
    target: input.target,
    partitionKeyPaths: input.partitionKeyPaths,
    address: input.address,
    rowRid: isRecord(input.row) && typeof input.row._rid === 'string' ? input.row._rid : undefined,
    mode: input.mode ?? 'edit',
    phase: 'reading',
    serverCopy: undefined,
    etag: undefined,
    draft: '',
    revision: 0,
    saving: false,
    notice: undefined
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
    case 'deleteStarted':
      return { ...session, saving: true, notice: undefined }
    case 'deleteSucceeded':
      return {
        ...session,
        saving: false,
        phase: 'deleted',
        notice: { kind: 'deleted', requestCharge: event.requestCharge, alreadyDeleted: false }
      }
    case 'deleteOutcome':
      // Someone else already deleted it: the outcome wanted, so done.
      if (event.outcome === 'not-found') {
        return {
          ...session,
          saving: false,
          phase: 'deleted',
          notice: { kind: 'deleted', requestCharge: event.requestCharge, alreadyDeleted: true }
        }
      }
      return { ...session, saving: false, notice: { kind: 'concurrent-change-on-delete' } }
    case 'deleteFailed':
      return { ...session, saving: false, notice: { kind: 'error', message: event.message } }
    case 'reviewRequested':
      return { ...session, phase: 'reading', serverCopy: undefined, etag: undefined, notice: undefined }
    case 'deleteRequested':
      if (session.mode === 'delete' || session.saving) return session
      if (hasUnsavedEdits(session)) {
        return {
          ...session,
          notice: { kind: 'error', message: 'Save or discard your edits before deleting this document.' }
        }
      }
      return {
        ...session,
        mode: 'delete',
        phase: 'reading',
        serverCopy: undefined,
        etag: undefined,
        notice: undefined
      }
    case 'editRequested':
      if (session.mode === 'edit' || session.saving) return session
      return { ...session, mode: 'edit', notice: undefined }
  }
}

/** Every edit session of one query tab's results; several show as tabs
 * across the top of the drawer. */
export interface EditSessionsState {
  sessions: EditSession[]
  activeKey: number | undefined
  /** A delete just finished: shown once as a toast, then cleared with
   * `toastShown`. `key` is the deleted edit session's. */
  toast?: { key: number; message: string }
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
      /** Edit document… (default) or Delete document…. */
      mode?: EditSessionMode
    }
  | { type: 'selected'; key: number }
  | { type: 'closed'; key: number }
  | { type: 'session'; key: number; event: EditSessionEvent }
  | { type: 'toastShown'; key: number }

export function editSessionsReducer(
  state: EditSessionsState,
  action: EditSessionsAction
): EditSessionsState {
  switch (action.type) {
    case 'opened': {
      const existing = findEditSession(state, action.target, action.address)
      if (existing) {
        const event: EditSessionEvent = { type: action.mode === 'delete' ? 'deleteRequested' : 'editRequested' }
        return {
          ...state,
          sessions: state.sessions.map((s) => (s.key === existing.key ? editSessionReducer(s, event) : s)),
          activeKey: existing.key
        }
      }
      return { sessions: [...state.sessions, openEditSession(action)], activeKey: action.key }
    }
    case 'selected':
      return state.sessions.some((s) => s.key === action.key) ? { ...state, activeKey: action.key } : state
    case 'closed':
      return withoutSession(state, action.key)
    case 'session': {
      const session = state.sessions.find((s) => s.key === action.key)
      if (!session) return state
      const next = editSessionReducer(session, action.event)
      if (next.phase === 'deleted' && next.notice?.kind === 'deleted') {
        return { ...withoutSession(state, action.key), toast: { key: action.key, message: deletedToast(next) } }
      }
      return { ...state, sessions: state.sessions.map((s) => (s.key === action.key ? next : s)) }
    }
    case 'toastShown':
      return state.toast?.key === action.key ? { ...state, toast: undefined } : state
  }
}

function withoutSession(state: EditSessionsState, key: number): EditSessionsState {
  const sessions = state.sessions.filter((s) => s.key !== key)
  const activeKey = state.activeKey === key ? sessions[sessions.length - 1]?.key : state.activeKey
  return { ...state, sessions, activeKey }
}

/** Story 30 ("Deleted `<id>` · RU") and story 48 (a 404 is done). */
function deletedToast(session: EditSession): string {
  const notice = session.notice
  if (notice?.kind === 'deleted' && notice.alreadyDeleted) return 'This document was already deleted.'
  const charge = notice?.kind === 'deleted' ? notice.requestCharge : 0
  return `Deleted ${session.address.id} · ${charge.toFixed(2)} RU`
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
  if (session.phase !== 'editing' || session.etag === undefined) {
    return { ok: false, notice: { kind: 'error', message: 'The document has not been read yet.' } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(session.draft)
  } catch (err) {
    return { ok: false, notice: { kind: 'invalid-body', message: (err as Error).message } }
  }
  if (!isRecord(parsed)) {
    return { ok: false, notice: { kind: 'invalid-body', message: 'A document must be a JSON object.' } }
  }

  const { address, partitionKeyPaths } = session
  const body = stripSystemProperties(parsed)
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

/**
 * What Delete document sends for this session: a `delete` carrying the
 * session's etag, so a version changed since the point-read is refused as
 * a Concurrent Change rather than removed blind.
 */
export function planDelete(session: EditSession): SavePlan {
  if (session.phase !== 'editing' || session.etag === undefined) {
    return { ok: false, notice: { kind: 'error', message: 'The document has not been read yet.' } }
  }
  // No delete anyway (story 44): only a fresh read can lead to a delete.
  if (session.notice?.kind === 'concurrent-change-on-delete') {
    return { ok: false, notice: session.notice }
  }
  return {
    ok: true,
    write: {
      kind: 'delete',
      id: session.address.id,
      partitionKey: session.address.partitionKey,
      ifMatch: session.etag,
      database: session.target.database,
      container: session.target.container
    }
  }
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

/** The Delete preview (story 60): the document as it would be re-created,
 * with `id` and partition key values but without system properties, so a
 * copy of it is a usable manual backup. */
export function deletePreviewText(session: EditSession): string {
  return session.serverCopy ? JSON.stringify(stripSystemProperties(session.serverCopy), null, 2) : ''
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
