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
  /** Set while this is a New document session (until its create succeeds):
   * the `id` and partition key fields as typed. `address` is then the
   * prefill or the last create attempt, not a stored document. */
  newDocument?: NewDocumentFields
  /** The compare view is open (story 38): the server copy, as read by
   * Compare, side by side with the draft. The drawer widens. */
  comparing?: boolean
  /** A point-read of the current version is in flight for Compare,
   * Overwrite with mine or Reload. */
  pendingRead?: CurrentVersionRead
  /** The write in flight is Save as new document. */
  savingAsNew?: boolean
}

/** Why the current version is being read while the session is open. */
export type CurrentVersionRead = 'compare' | 'overwrite'

/** New document's editable address fields: the `id`, and one partition key
 * field per level (see `parsePartitionKeyInput`). */
export interface NewDocumentFields {
  id: string
  partitionKey: string[]
}

/** What the drawer shows above the editor. */
export type EditNotice =
  | { kind: 'saved' | 'created'; requestCharge: number }
  /** A create found a document already at this address (409). */
  | { kind: 'id-clash'; address: DocumentAddress }
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
  /** New document's `id` / partition key fields were edited. */
  | { type: 'newDocumentFieldsChanged'; fields: NewDocumentFields }
  | { type: 'saveRefused'; notice: EditNotice }
  /** `address`: where a create is sent (New document), recorded so an `id`
   * clash can name it. */
  /** `asNew`: Save as new document, a create at the session's address
   * after it was found deleted. */
  | { type: 'saveStarted'; address?: DocumentAddress; asNew?: boolean }
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
  /** Compare, after a Concurrent Change: read the current version and open
   * the compare view, keeping the draft. */
  | { type: 'compareRequested' }
  /** Overwrite with mine, in the compare view only: read the current
   * version, then replace it carrying that read's etag. */
  | { type: 'overwriteRequested' }
  /** Reload: discard the draft and read the current version, as on open. */
  | { type: 'reloadRequested' }
  /** Compare or Overwrite with mine found the document deleted. */
  | { type: 'currentVersionNotFound' }
  | { type: 'currentVersionReadFailed'; message: string }
  /** The current version read for Compare or Overwrite with mine. */
  | { type: 'currentVersionRead'; document: StoredDocument }

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

/** A New document session (stories 4, 26): editable `id` and partition key
 * fields above the body. Opened `from` an Edit ("Different address? New
 * document", story 21), it starts with that session's address in the
 * fields and its current draft, unsaved edits included, as the body. */
export function openNewDocumentSession(input: {
  key: number
  target: DocumentTarget
  partitionKeyPaths: readonly string[]
  from?: EditSession
}): EditSession {
  const { from } = input
  const fields: NewDocumentFields = from
    ? (from.newDocument ?? newDocumentFieldsAt(from.address, from.partitionKeyPaths))
    : { id: '', partitionKey: input.partitionKeyPaths.map(() => '') }
  return {
    key: input.key,
    target: input.target,
    partitionKeyPaths: input.partitionKeyPaths,
    mode: 'edit',
    address: { id: '', partitionKey: null },
    rowRid: undefined,
    phase: 'editing',
    serverCopy: undefined,
    etag: undefined,
    draft: from?.draft || '{}',
    revision: 0,
    saving: false,
    notice: undefined,
    newDocument: fields
  }
}

/** New document's fields filled in with `address`. */
function newDocumentFieldsAt(
  address: DocumentAddress,
  partitionKeyPaths: readonly string[]
): NewDocumentFields {
  return {
    id: address.id,
    partitionKey: partitionKeyLevels(address.partitionKey, partitionKeyPaths.length).map(
      partitionKeyInputText
    )
  }
}

/** A partition key value as New document's field text, the inverse of
 * `parsePartitionKeyInput`: a string that would read back as another value
 * is quoted; the None value (no property) leaves the field empty. */
export function partitionKeyInputText(level: PartitionKeyLevelValue): string {
  if (isNoneValue(level)) return ''
  if (typeof level !== 'string') return JSON.stringify(level)
  return parsePartitionKeyInput(level) === level ? level : JSON.stringify(level)
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
      return {
        ...session,
        address: event.address ?? session.address,
        saving: true,
        savingAsNew: event.asNew,
        notice: undefined
      }
    case 'saveSucceeded':
      // A created document is edited from here on like any other.
      return {
        ...session,
        newDocument: undefined,
        comparing: false,
        saving: false,
        savingAsNew: undefined,
        serverCopy: event.document,
        etag: etagOf(event.document),
        draft: editorText(event.document, session.partitionKeyPaths),
        revision: session.revision + 1,
        notice: {
          kind: session.newDocument || session.savingAsNew ? 'created' : 'saved',
          requestCharge: event.requestCharge
        }
      }
    case 'saveOutcome':
      // In the compare view a Concurrent Change refreshes the server side.
      if (session.comparing && event.outcome === 'precondition-failed') {
        return { ...session, saving: false, pendingRead: 'compare', notice: { kind: 'concurrent-change' } }
      }
      // Someone created it again first: the id clash case, as a New document
      // at that address, so Open existing can open theirs next to mine.
      if (session.savingAsNew && event.outcome === 'conflict') {
        return {
          ...session,
          saving: false,
          savingAsNew: undefined,
          comparing: false,
          newDocument: newDocumentFieldsAt(session.address, session.partitionKeyPaths),
          notice: noticeForOutcome(event.outcome, session.address)
        }
      }
      return {
        ...session,
        saving: false,
        savingAsNew: undefined,
        comparing: event.outcome === 'not-found' ? false : session.comparing,
        notice: noticeForOutcome(event.outcome, session.address)
      }
    case 'saveFailed':
      return {
        ...session,
        saving: false,
        savingAsNew: undefined,
        notice: { kind: 'error', message: event.message }
      }
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
    case 'compareRequested':
      if (isBusy(session) || session.newDocument) return session
      return { ...session, comparing: true, pendingRead: 'compare', notice: undefined }
    case 'reloadRequested':
      if (isBusy(session) || session.newDocument) return session
      return {
        ...session,
        phase: 'reading',
        comparing: false,
        serverCopy: undefined,
        etag: undefined,
        notice: undefined
      }
    case 'currentVersionNotFound':
      return { ...session, pendingRead: undefined, comparing: false, notice: { kind: 'deleted-while-editing' } }
    case 'currentVersionReadFailed':
      return { ...session, pendingRead: undefined, notice: { kind: 'error', message: event.message } }
    case 'overwriteRequested':
      // Never an unconditional write: a fresh read supplies the etag.
      if (!session.comparing || isBusy(session)) return session
      return { ...session, pendingRead: 'overwrite', notice: undefined }
    case 'currentVersionRead':
      // The draft (my side) is kept; Save from here carries this etag.
      return {
        ...session,
        pendingRead: undefined,
        serverCopy: event.document,
        etag: etagOf(event.document)
      }
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
  /** Closing this session would discard unsaved edits (story 27): the
   * drawer asks first. Cleared by Keep editing or a switch of session tab. */
  confirmingClose?: number
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
  /** Discards the session at once (also: Discard edits, after asking). */
  | { type: 'closed'; key: number }
  /** Close or a session tab's close: asks first when edits would be lost. */
  | { type: 'closeRequested'; key: number }
  /** Keep editing: the session stays open with its edits. */
  | { type: 'closeCancelled' }
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
    case 'newDocumentOpened': {
      const from = state.sessions.find((s) => s.key === action.from)
      return {
        sessions: [...state.sessions, openNewDocumentSession({ ...action, from })],
        activeKey: action.key
      }
    }
    case 'selected':
      return state.sessions.some((s) => s.key === action.key)
        ? { ...state, activeKey: action.key, confirmingClose: undefined }
        : state
    case 'closeRequested': {
      const session = state.sessions.find((s) => s.key === action.key)
      if (!session) return state
      if (!hasUnsavedEdits(session)) return withoutSession(state, action.key)
      return { ...state, activeKey: action.key, confirmingClose: action.key }
    }
    case 'closeCancelled':
      return { ...state, confirmingClose: undefined }
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
  const confirmingClose = state.confirmingClose === key ? undefined : state.confirmingClose
  return { ...state, sessions, activeKey, confirmingClose }
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
  return state.sessions.find(
    (s) => !s.newDocument && sameTarget(s.target, target) && sameAddress(s.address, address)
  )
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
  const planned = bodyAtAddress(session)
  if (!planned.ok) return planned
  const { address } = session
  return {
    ok: true,
    write: {
      kind: 'replace',
      id: address.id,
      partitionKey: address.partitionKey,
      ifMatch: session.etag,
      body: planned.body,
      database: session.target.database,
      container: session.target.container
    }
  }
}

/**
 * What Save as new document sends after a 404 on Save (story 47): a
 * `create` at the session's own address with the draft, the same body a
 * Save would have sent. Only offered once the document was found deleted.
 */
export function planSaveAsNew(session: EditSession): SavePlan {
  if (session.newDocument || session.notice?.kind !== 'deleted-while-editing') {
    return { ok: false, notice: { kind: 'error', message: 'The document has not been found deleted.' } }
  }
  const planned = bodyAtAddress(session)
  if (!planned.ok) return planned
  const { address } = session
  return {
    ok: true,
    write: {
      kind: 'create',
      id: address.id,
      partitionKey: address.partitionKey,
      body: planned.body,
      database: session.target.database,
      container: session.target.container
    }
  }
}

/** The draft as a body for the session's locked address: system properties
 * stripped, `id` and partition key values restored. Refused when the draft
 * isn't a JSON object or changes the address. */
function bodyAtAddress(
  session: EditSession
): { ok: true; body: Record<string, unknown> } | { ok: false; notice: EditNotice } {
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
  return { ok: true, body: { ...body, id: address.id } }
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
function noticeForOutcome(
  outcome: 'precondition-failed' | 'not-found' | 'conflict',
  address: DocumentAddress
): EditNotice {
  switch (outcome) {
    case 'precondition-failed':
      return { kind: 'concurrent-change' }
    case 'not-found':
      return { kind: 'deleted-while-editing' }
    case 'conflict':
      // Only a create can clash; the draft is kept for another id.
      return { kind: 'id-clash', address }
  }
}

/** A Document Write or a point-read of the current version is in flight. */
export function isBusy(session: EditSession): boolean {
  return session.saving || session.pendingRead !== undefined
}

/** True when the draft differs from the server copy's editor text; for a
 * New document, once anything has been typed. */
export function hasUnsavedEdits(session: EditSession): boolean {
  if (session.newDocument) {
    const { id, partitionKey } = session.newDocument
    return id !== '' || partitionKey.some((text) => text !== '') || session.draft.replace(/\s/g, '') !== '{}'
  }
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
