import { describe, expect, it } from 'vitest'
import {
  editSessionReducer,
  hasUnsavedEdits,
  openEditSession,
  planSave,
  planSaveAsNew,
  type EditSession,
  type EditSessionEvent
} from './edit-session'

const target = { connectionId: 'profile-1', database: 'orders-db', container: 'orders' }

const stored = {
  id: 'a1',
  customerId: 'c9',
  name: 'Ada',
  _rid: 'rid-1',
  _self: 'dbs/x/colls/y/docs/rid-1/',
  _etag: '"etag-1"',
  _attachments: 'attachments/',
  _ts: 1_700_000_000
}

/** The version someone else saved after the session read `stored`. */
const theirs = { ...stored, name: 'Ada King', _etag: '"etag-theirs"', _ts: 1_700_000_050 }

const mine = { name: 'Ada Lovelace' }

function apply(session: EditSession, ...events: EditSessionEvent[]): EditSession {
  return events.reduce(editSessionReducer, session)
}

/** An edit session whose Save just met a Concurrent Change, edits kept. */
function concurrentlyChanged(): EditSession {
  const session = openEditSession({
    key: 1,
    target,
    partitionKeyPaths: ['/customerId'],
    address: { id: 'a1', partitionKey: 'c9' },
    row: { id: 'a1', customerId: 'c9', name: 'Ada' }
  })
  return apply(
    session,
    { type: 'readSucceeded', document: stored },
    { type: 'draftChanged', text: JSON.stringify(mine) },
    { type: 'saveStarted' },
    { type: 'saveOutcome', outcome: 'precondition-failed', requestCharge: 1.24 }
  )
}

describe('Compare after a Concurrent Change on Save', () => {
  it('reads the current version and opens the compare view, server now vs my edits', () => {
    const reading = apply(concurrentlyChanged(), { type: 'compareRequested' })
    expect(reading).toMatchObject({ comparing: true, pendingRead: 'compare' })

    const compared = apply(reading, { type: 'currentVersionRead', document: theirs })
    expect(compared).toMatchObject({ comparing: true, pendingRead: undefined, serverCopy: theirs })
    expect(JSON.parse(compared.draft)).toEqual(mine)
  })

  it('Save from the compare view sends a replace with the etag of that read', () => {
    expect(planSave(comparing())).toMatchObject({
      ok: true,
      write: { kind: 'replace', ifMatch: '"etag-theirs"', body: { ...mine, id: 'a1', customerId: 'c9' } }
    })
  })

  it('a successful Save from the compare view goes back to the editor with the saved version', () => {
    const savedCopy = { ...stored, ...mine, _etag: '"etag-3"' }
    const saved = apply(
      comparing(),
      { type: 'saveStarted' },
      { type: 'saveSucceeded', document: savedCopy, requestCharge: 10.29 }
    )
    expect(saved).toMatchObject({
      comparing: false,
      etag: '"etag-3"',
      notice: { kind: 'saved', requestCharge: 10.29 }
    })
  })

  it('another Concurrent Change while comparing repeats the notice, refreshes the server side and keeps my side', () => {
    const again = apply(
      comparing(),
      { type: 'draftChanged', text: JSON.stringify({ name: 'Ada King Lovelace' }) },
      { type: 'saveStarted' },
      { type: 'saveOutcome', outcome: 'precondition-failed', requestCharge: 1.24 }
    )
    expect(again).toMatchObject({
      comparing: true,
      pendingRead: 'compare',
      notice: { kind: 'concurrent-change' }
    })

    const newest = { ...theirs, name: 'Augusta Ada King', _etag: '"etag-newest"' }
    const refreshed = apply(again, { type: 'currentVersionRead', document: newest })
    expect(refreshed).toMatchObject({
      comparing: true,
      serverCopy: newest,
      notice: { kind: 'concurrent-change' }
    })
    expect(JSON.parse(refreshed.draft)).toEqual({ name: 'Ada King Lovelace' })
    expect(planSave(refreshed)).toMatchObject({ ok: true, write: { ifMatch: '"etag-newest"' } })
  })
})

describe('Overwrite with mine', () => {
  it('is reachable only from the compare view', () => {
    const session = concurrentlyChanged()
    expect(apply(session, { type: 'overwriteRequested' })).toBe(session)
  })

  it('reads the current version afresh, then replaces it with my edits carrying that etag', () => {
    const reading = apply(comparing(), { type: 'overwriteRequested' })
    expect(reading).toMatchObject({ comparing: true, pendingRead: 'overwrite' })

    const newest = { ...theirs, name: 'Augusta Ada King', _etag: '"etag-newest"' }
    const read = apply(reading, { type: 'currentVersionRead', document: newest })
    expect(read).toMatchObject({ pendingRead: undefined, serverCopy: newest })
    expect(planSave(read)).toMatchObject({
      ok: true,
      write: { kind: 'replace', ifMatch: '"etag-newest"', body: { ...mine, id: 'a1', customerId: 'c9' } }
    })
  })
})

describe('Reload after a Concurrent Change on Save', () => {
  it('discards my edits and loads the current version', () => {
    const reloading = apply(concurrentlyChanged(), { type: 'reloadRequested' })
    expect(reloading).toMatchObject({ phase: 'reading', notice: undefined })

    const reloaded = apply(reloading, { type: 'readSucceeded', document: theirs })
    expect(reloaded).toMatchObject({ phase: 'editing', serverCopy: theirs, etag: '"etag-theirs"' })
    expect(JSON.parse(reloaded.draft)).toEqual({ name: 'Ada King' })
    expect(hasUnsavedEdits(reloaded)).toBe(false)
  })

  it('from the compare view, goes back to the editor with the current version', () => {
    const reloaded = apply(
      comparing(),
      { type: 'reloadRequested' },
      { type: 'readSucceeded', document: theirs }
    )
    expect(reloaded).toMatchObject({ phase: 'editing', comparing: false, serverCopy: theirs })
    expect(hasUnsavedEdits(reloaded)).toBe(false)
  })
})

describe('a document deleted while editing', () => {
  function deletedWhileEditing(): EditSession {
    return apply(
      concurrentlyChanged(),
      { type: 'saveStarted' },
      { type: 'saveOutcome', outcome: 'not-found', requestCharge: 1 }
    )
  }

  it('Save as new document sends a create at the same address, keeping my edits', () => {
    expect(planSaveAsNew(deletedWhileEditing())).toEqual({
      ok: true,
      write: {
        kind: 'create',
        id: 'a1',
        partitionKey: 'c9',
        body: { ...mine, id: 'a1', customerId: 'c9' },
        database: 'orders-db',
        container: 'orders'
      }
    })
  })

  it('offers Save as new document only once the document was found deleted', () => {
    expect(planSaveAsNew(concurrentlyChanged())).toMatchObject({ ok: false })
  })

  it('becomes an edit session of the document created again, carrying its etag', () => {
    const created = { ...stored, ...mine, _rid: 'rid-2', _etag: '"etag-created"' }
    const session = apply(
      deletedWhileEditing(),
      { type: 'saveStarted', asNew: true },
      { type: 'saveSucceeded', document: created, requestCharge: 6.1 }
    )
    expect(session).toMatchObject({
      phase: 'editing',
      newDocument: undefined,
      serverCopy: created,
      etag: '"etag-created"',
      notice: { kind: 'created', requestCharge: 6.1 }
    })
    expect(hasUnsavedEdits(session)).toBe(false)
  })

  it('an id clash on Save as new document keeps my edits as a New document at that address', () => {
    const session = apply(
      deletedWhileEditing(),
      { type: 'saveStarted', asNew: true },
      { type: 'saveOutcome', outcome: 'conflict', requestCharge: 1.3 }
    )
    expect(session).toMatchObject({
      newDocument: { id: 'a1', partitionKey: ['c9'] },
      notice: { kind: 'id-clash', address: { id: 'a1', partitionKey: 'c9' } }
    })
    expect(JSON.parse(session.draft)).toEqual(mine)
  })

  it('Compare that finds the document deleted says so and offers Save as new document', () => {
    const session = apply(concurrentlyChanged(), { type: 'compareRequested' }, { type: 'currentVersionNotFound' })
    expect(session).toMatchObject({
      comparing: false,
      pendingRead: undefined,
      notice: { kind: 'deleted-while-editing' }
    })
    expect(JSON.parse(session.draft)).toEqual(mine)
    expect(planSaveAsNew(session)).toMatchObject({ ok: true, write: { kind: 'create' } })
  })

  it('Overwrite with mine that finds the document deleted offers Save as new document', () => {
    const session = apply(comparing(), { type: 'overwriteRequested' }, { type: 'currentVersionNotFound' })
    expect(session).toMatchObject({ comparing: false, notice: { kind: 'deleted-while-editing' } })
  })
})

describe('reading the current version fails unexpectedly', () => {
  it('keeps my edits and the compare view, showing the scrubbed message', () => {
    const session = apply(
      comparing(),
      { type: 'overwriteRequested' },
      { type: 'currentVersionReadFailed', message: 'Request timed out' }
    )
    expect(session).toMatchObject({
      comparing: true,
      pendingRead: undefined,
      serverCopy: theirs,
      notice: { kind: 'error', message: 'Request timed out' }
    })
  })
})

/** The compare view, open on `theirs` with my edits on the other side. */
function comparing(): EditSession {
  return apply(
    concurrentlyChanged(),
    { type: 'compareRequested' },
    { type: 'currentVersionRead', document: theirs }
  )
}
