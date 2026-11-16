import { describe, expect, it } from 'vitest'
import {
  editSessionReducer,
  editSessionsReducer,
  findEditSession,
  hasUnsavedEdits,
  initialEditSessionsState,
  deletePreviewText,
  openEditSession,
  openNewDocumentSession,
  planDelete,
  planSave,
  type EditSession,
  type EditSessionEvent,
  type EditSessionsAction,
  type EditSessionsState
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

function opened(row: unknown = { id: 'a1', customerId: 'c9', name: 'Ada' }): EditSession {
  return openEditSession({
    key: 1,
    target,
    partitionKeyPaths: ['/customerId'],
    address: { id: 'a1', partitionKey: 'c9' },
    row
  })
}

describe('editSessionReducer', () => {
  it('opens reading the latest version of the document', () => {
    expect(opened()).toMatchObject({ phase: 'reading', address: { id: 'a1', partitionKey: 'c9' } })
  })

  it('edits the server copy once read: body only, etag held by the session', () => {
    const session = editSessionReducer(opened(), { type: 'readSucceeded', document: stored })
    expect(session).toMatchObject({ phase: 'editing', etag: '"etag-1"', serverCopy: stored })
    expect(JSON.parse(session.draft)).toEqual({ name: 'Ada' })
  })

  it('shows the document no longer exists when the point-read finds nothing', () => {
    expect(editSessionReducer(opened(), { type: 'readNotFound' })).toMatchObject({
      phase: 'missing',
      serverCopy: undefined
    })
  })

  it('refuses to edit a row whose _rid differs from the server copy', () => {
    const row = { ...stored, _rid: 'rid-before-recreate' }
    const session = editSessionReducer(opened(row), { type: 'readSucceeded', document: stored })
    expect(session).toMatchObject({ phase: 'out-of-date', serverCopy: undefined, etag: undefined })
  })

  it('shows the scrubbed message when the point-read fails unexpectedly', () => {
    expect(
      editSessionReducer(opened(), { type: 'readFailed', message: 'Request timed out' })
    ).toMatchObject({ phase: 'read-failed', notice: { kind: 'error', message: 'Request timed out' } })
  })
})

function editing(document: Record<string, unknown> = stored, draft?: unknown): EditSession {
  const session = editSessionReducer(opened(), { type: 'readSucceeded', document })
  return draft === undefined
    ? session
    : editSessionReducer(session, { type: 'draftChanged', text: JSON.stringify(draft) })
}

describe('planSave', () => {
  it('sends a replace Document Write with the session etag, id and partition key restored', () => {
    expect(planSave(editing(stored, { name: 'Ada Lovelace' }))).toEqual({
      ok: true,
      write: {
        kind: 'replace',
        id: 'a1',
        partitionKey: 'c9',
        ifMatch: '"etag-1"',
        body: { name: 'Ada Lovelace', id: 'a1', customerId: 'c9' },
        database: 'orders-db',
        container: 'orders'
      }
    })
  })

  it('strips system properties from the body and ignores the _etag typed into the draft', () => {
    const plan = planSave(
      editing(stored, { name: 'Ada', _etag: '"typed-by-user"', _ts: 1, _rid: 'x', _self: 'y', _attachments: 'z' })
    )
    expect(plan).toMatchObject({ ok: true, write: { ifMatch: '"etag-1"' } })
    expect(plan.ok && plan.write.kind === 'replace' && plan.write.body).toEqual({
      name: 'Ada',
      id: 'a1',
      customerId: 'c9'
    })
  })

  it('accepts an unchanged id or partition key value left in the draft', () => {
    expect(planSave(editing(stored, { id: 'a1', customerId: 'c9', name: 'Ada' }))).toMatchObject({
      ok: true
    })
  })

  it.each([
    ['id', { id: 'a2', name: 'Ada' }, ['id']],
    ['the partition key value', { customerId: 'c10', name: 'Ada' }, ['customerId']],
    ['both', { id: 'a2', customerId: null }, ['id', 'customerId']]
  ])('refuses Save, pointing to New document, when the draft changes %s', (_label, draft, fields) => {
    expect(planSave(editing(stored, draft))).toEqual({
      ok: false,
      notice: { kind: 'address-changed', fields }
    })
  })

  it('refuses giving a value to a partition key field that is None on the server copy', () => {
    const noKey = { id: 'a1', name: 'Ada', _rid: 'rid-1', _self: 's', _etag: '"etag-1"', _ts: 1 }
    const session = openEditSession({
      key: 1,
      target,
      partitionKeyPaths: ['/customerId'],
      address: { id: 'a1', partitionKey: {} },
      row: noKey
    })
    const read = editSessionReducer(session, { type: 'readSucceeded', document: noKey })
    const withKey = editSessionReducer(read, {
      type: 'draftChanged',
      text: JSON.stringify({ name: 'Ada', customerId: 'c1' })
    })
    expect(planSave(withKey)).toEqual({ ok: false, notice: { kind: 'address-changed', fields: ['customerId'] } })
    expect(planSave(read)).toMatchObject({
      ok: true,
      write: { partitionKey: {}, body: { name: 'Ada', id: 'a1' } }
    })
  })

  it('restores every level of a hierarchical, nested partition key into the body', () => {
    const doc = { id: 'a1', tenant: 't1', geo: { region: 'us', city: 'Bentonville' }, _etag: '"e"' }
    const session = editSessionReducer(
      openEditSession({
        key: 1,
        target,
        partitionKeyPaths: ['/tenant', '/geo/region'],
        address: { id: 'a1', partitionKey: ['t1', 'us'] },
        row: doc
      }),
      { type: 'readSucceeded', document: doc }
    )
    expect(JSON.parse(session.draft)).toEqual({ geo: { city: 'Bentonville' } })
    expect(planSave(session)).toMatchObject({
      ok: true,
      write: {
        partitionKey: ['t1', 'us'],
        body: { id: 'a1', tenant: 't1', geo: { region: 'us', city: 'Bentonville' } }
      }
    })
    const moved = editSessionReducer(session, {
      type: 'draftChanged',
      text: JSON.stringify({ geo: { region: 'eu', city: 'Bentonville' } })
    })
    expect(planSave(moved)).toEqual({ ok: false, notice: { kind: 'address-changed', fields: ['geo.region'] } })
  })

  it.each([
    ['text that is not JSON', '{ "name": '],
    ['a JSON array', '[1, 2]'],
    ['a JSON scalar', '42']
  ])('refuses %s as the body', (_label, text) => {
    const session = editSessionReducer(editing(), { type: 'draftChanged', text })
    expect(planSave(session)).toMatchObject({ ok: false, notice: { kind: 'invalid-body' } })
  })
})

describe('saving an edit session', () => {
  const savedCopy = { ...stored, name: 'Ada Lovelace', _etag: '"etag-2"', _ts: 1_700_000_100 }

  function saving(): EditSession {
    return editSessionReducer(editing(stored, { name: 'Ada Lovelace' }), { type: 'saveStarted' })
  }

  it('is busy while the Document Write is in flight', () => {
    expect(saving()).toMatchObject({ saving: true, notice: undefined })
  })

  it('refreshes the etag and server copy from the returned document, so the same document can be saved again', () => {
    const saved = editSessionReducer(saving(), {
      type: 'saveSucceeded',
      document: savedCopy,
      requestCharge: 10.29
    })
    expect(saved).toMatchObject({
      saving: false,
      etag: '"etag-2"',
      serverCopy: savedCopy,
      notice: { kind: 'saved', requestCharge: 10.29 }
    })
    expect(hasUnsavedEdits(saved)).toBe(false)

    const again = editSessionReducer(saved, {
      type: 'draftChanged',
      text: JSON.stringify({ name: 'Countess Lovelace' })
    })
    expect(planSave(again)).toMatchObject({ ok: true, write: { ifMatch: '"etag-2"' } })
  })

  it('keeps the draft and shows a Concurrent Change when the etag no longer matches', () => {
    const refused = editSessionReducer(saving(), {
      type: 'saveOutcome',
      outcome: 'precondition-failed',
      requestCharge: 1.24
    })
    expect(refused).toMatchObject({ saving: false, etag: '"etag-1"', notice: { kind: 'concurrent-change' } })
    expect(JSON.parse(refused.draft)).toEqual({ name: 'Ada Lovelace' })
  })

  it('keeps the draft and says the document was deleted since it was opened', () => {
    const refused = editSessionReducer(saving(), {
      type: 'saveOutcome',
      outcome: 'not-found',
      requestCharge: 1
    })
    expect(refused).toMatchObject({ saving: false, notice: { kind: 'deleted-while-editing' } })
    expect(JSON.parse(refused.draft)).toEqual({ name: 'Ada Lovelace' })
  })

  it('keeps the draft and shows the scrubbed message of an unexpected write error', () => {
    const failed = editSessionReducer(saving(), { type: 'saveFailed', message: 'Request rate is large' })
    expect(failed).toMatchObject({ saving: false, notice: { kind: 'error', message: 'Request rate is large' } })
    expect(hasUnsavedEdits(failed)).toBe(true)
  })

  it('shows why Save was refused without sending anything', () => {
    const session = editing(stored, { id: 'a2' })
    const plan = planSave(session)
    if (plan.ok) throw new Error('expected a refusal')
    expect(editSessionReducer(session, { type: 'saveRefused', notice: plan.notice })).toMatchObject({
      saving: false,
      notice: { kind: 'address-changed', fields: ['id'] }
    })
  })
})

describe('editSessionsReducer', () => {
  const open = (key: number, id: string, partitionKey = 'c9'): EditSessionsAction => ({
    type: 'opened',
    key,
    target,
    partitionKeyPaths: ['/customerId'],
    address: { id, partitionKey },
    row: { id, customerId: partitionKey }
  })

  it('opens each document in its own edit session and focuses the newest', () => {
    const state = [open(1, 'a1'), open(2, 'a2')].reduce(editSessionsReducer, initialEditSessionsState)
    expect(state.sessions.map((s) => s.address.id)).toEqual(['a1', 'a2'])
    expect(state.activeKey).toBe(2)
  })

  it('focuses the open edit session instead of opening the same document twice', () => {
    const state = [open(1, 'a1'), open(2, 'a2'), open(3, 'a1')].reduce(
      editSessionsReducer,
      initialEditSessionsState
    )
    expect(state.sessions.map((s) => s.key)).toEqual([1, 2])
    expect(state.activeKey).toBe(1)
  })

  it('tells documents apart by partition key value as well as id', () => {
    const state = [open(1, 'a1', 'c9'), open(2, 'a1', 'c10')].reduce(
      editSessionsReducer,
      initialEditSessionsState
    )
    expect(state.sessions).toHaveLength(2)
  })

  it('routes events to their edit session and ignores events for a closed one', () => {
    let state = [open(1, 'a1'), open(2, 'a2')].reduce(editSessionsReducer, initialEditSessionsState)
    state = editSessionsReducer(state, { type: 'session', key: 1, event: { type: 'readNotFound' } })
    expect(state.sessions.map((s) => s.phase)).toEqual(['missing', 'reading'])

    state = editSessionsReducer(state, { type: 'closed', key: 2 })
    expect(state.activeKey).toBe(1)
    const after = editSessionsReducer(state, { type: 'session', key: 2, event: { type: 'readNotFound' } })
    expect(after).toEqual(state)
  })

  it('switches between edit sessions and leaves none active once all are closed', () => {
    let state = [open(1, 'a1'), open(2, 'a2')].reduce(editSessionsReducer, initialEditSessionsState)
    state = editSessionsReducer(state, { type: 'selected', key: 1 })
    expect(state.activeKey).toBe(1)
    state = editSessionsReducer(state, { type: 'closed', key: 1 })
    state = editSessionsReducer(state, { type: 'closed', key: 2 })
    expect(state).toMatchObject({ sessions: [], activeKey: undefined })
  })
})

describe('New document', () => {
  const newDocument = (key: number, from?: number): EditSessionsAction => ({
    type: 'newDocumentOpened',
    key,
    target,
    partitionKeyPaths: ['/customerId'],
    from
  })

  it('opens an editing session with empty id and partition key fields above an empty body', () => {
    const state = editSessionsReducer(initialEditSessionsState, newDocument(1))
    expect(state.activeKey).toBe(1)
    expect(state.sessions[0]).toMatchObject({
      phase: 'editing',
      newDocument: { id: '', partitionKey: [''] },
      serverCopy: undefined,
      etag: undefined
    })
    expect(JSON.parse(state.sessions[0].draft)).toEqual({})
    expect(hasUnsavedEdits(state.sessions[0])).toBe(false)
  })

  it('"Different address? New document" opens a New document prefilled with the current body and address', () => {
    let state = editSessionsReducer(initialEditSessionsState, {
      type: 'opened',
      key: 1,
      target,
      partitionKeyPaths: ['/customerId'],
      address: { id: 'a1', partitionKey: 'c9' },
      row: stored
    })
    state = editSessionsReducer(state, { type: 'session', key: 1, event: { type: 'readSucceeded', document: stored } })
    state = editSessionsReducer(state, {
      type: 'session',
      key: 1,
      event: { type: 'draftChanged', text: '{"name":"Ada, unsaved"}' }
    })
    const before = state.sessions[0]
    state = editSessionsReducer(state, newDocument(2, 1))

    expect(state.activeKey).toBe(2)
    expect(state.sessions[0]).toBe(before)
    expect(state.sessions[1]).toMatchObject({
      newDocument: { id: 'a1', partitionKey: ['c9'] },
      draft: '{"name":"Ada, unsaved"}',
      target
    })
    expect(planSave(state.sessions[1])).toMatchObject({
      ok: true,
      write: { kind: 'create', id: 'a1', partitionKey: 'c9', body: { name: 'Ada, unsaved' } }
    })
  })

  it.each([
    ['a plain string', 'c9', 'c9'],
    ['a string that reads as a number', '72712', '"72712"'],
    ['a number', 72712, '72712'],
    ['JSON null', null, 'null'],
    ['the None value', {}, '']
  ])('prefills a partition key field holding %s so that it reads back the same', (_label, value, text) => {
    const doc = { ...stored, customerId: value }
    let state = editSessionsReducer(initialEditSessionsState, {
      type: 'opened',
      key: 1,
      target,
      partitionKeyPaths: ['/customerId'],
      address: { id: 'a1', partitionKey: value as never },
      row: doc
    })
    state = editSessionsReducer(state, newDocument(2, 1))
    expect(state.sessions[1].newDocument).toEqual({ id: 'a1', partitionKey: [text] })
  })

  it('gives a hierarchical partition key one field per level', () => {
    const state = editSessionsReducer(initialEditSessionsState, {
      type: 'newDocumentOpened',
      key: 1,
      target,
      partitionKeyPaths: ['/tenant', '/geo/region']
    })
    expect(state.sessions[0].newDocument).toEqual({ id: '', partitionKey: ['', ''] })
  })

  it('opens every New document in its own edit session', () => {
    const state = [newDocument(1), newDocument(2)].reduce(editSessionsReducer, initialEditSessionsState)
    expect(state.sessions.map((s) => s.key)).toEqual([1, 2])
    expect(state.activeKey).toBe(2)
  })
})

/** A New document session with these fields typed and this body. */
function newDocumentDraft(
  id: string,
  partitionKey: string[],
  body: unknown = {},
  partitionKeyPaths: string[] = ['/customerId']
): EditSession {
  let session = openNewDocumentSession({ key: 1, target, partitionKeyPaths })
  session = editSessionReducer(session, { type: 'newDocumentFieldsChanged', fields: { id, partitionKey } })
  return editSessionReducer(session, {
    type: 'draftChanged',
    text: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

describe('planSave for a New document', () => {
  it('sends a create Document Write with an explicit id and partition key, both also in the body', () => {
    expect(planSave(newDocumentDraft('n1', ['c9'], { name: 'Grace' }))).toEqual({
      ok: true,
      write: {
        kind: 'create',
        id: 'n1',
        partitionKey: 'c9',
        body: { name: 'Grace', id: 'n1', customerId: 'c9' },
        database: 'orders-db',
        container: 'orders'
      }
    })
  })

  it('strips system properties from the body', () => {
    const plan = planSave(
      newDocumentDraft('n1', ['c9'], { name: 'Grace', _etag: '"e"', _ts: 1, _rid: 'r', _self: 's', _attachments: 'a' })
    )
    expect(plan.ok && plan.write.kind === 'create' && plan.write.body).toEqual({ name: 'Grace', id: 'n1', customerId: 'c9' })
  })

  it('writes every level of a hierarchical, nested partition key into the body', () => {
    const plan = planSave(
      newDocumentDraft('n1', ['t1', 'us'], { geo: { city: 'Bentonville' } }, ['/tenant', '/geo/region'])
    )
    expect(plan).toMatchObject({
      ok: true,
      write: {
        partitionKey: ['t1', 'us'],
        body: { id: 'n1', tenant: 't1', geo: { region: 'us', city: 'Bentonville' } }
      }
    })
  })

  it.each([
    ['plain text as a string', 'c9', 'c9'],
    ['a JSON number as a number', '72712', 72712],
    ['a quoted JSON string as that string', '"72712"', '72712'],
    ['true as a boolean', 'true', true],
    ['null as JSON null', 'null', null]
  ])('reads a partition key field holding %s', (_label, text, value) => {
    expect(planSave(newDocumentDraft('n1', [text]))).toMatchObject({
      ok: true,
      write: { partitionKey: value, body: { customerId: value } }
    })
  })

  it('accepts an id or partition key value repeated unchanged in the body', () => {
    expect(planSave(newDocumentDraft('n1', ['c9'], { id: 'n1', customerId: 'c9' }))).toMatchObject({
      ok: true
    })
  })

  it.each([
    ['an empty id', '', 'c9', {}, 'Enter id for the new document.'],
    ['an empty partition key field', 'n1', '', {}, 'Enter customerId for the new document.'],
    ['both empty', '', '', {}, 'Enter id and customerId for the new document.'],
    [
      'a body id that differs from the id field',
      'n1',
      'c9',
      { id: 'n2' },
      "The body's id differs from the field above. Remove it from the body or make them match."
    ],
    [
      'a body partition key value that differs from its field',
      'n1',
      'c9',
      { customerId: 'c10' },
      "The body's customerId differs from the field above. Remove it from the body or make them match."
    ]
  ])('refuses Create with %s', (_label, id, pk, body, message) => {
    expect(planSave(newDocumentDraft(id, [pk], body))).toEqual({
      ok: false,
      notice: { kind: 'invalid-address', message }
    })
  })

  it('refuses a body that is not a JSON object', () => {
    expect(planSave(newDocumentDraft('n1', ['c9'], '[1]'))).toMatchObject({
      ok: false,
      notice: { kind: 'invalid-body' }
    })
  })

  function refused(session: EditSession): EditSession {
    const plan = planSave(session)
    if (plan.ok) throw new Error('expected Create to be refused')
    return editSessionReducer(session, { type: 'saveRefused', notice: plan.notice })
  }

  it('clears a Create refusal once the New document fields are edited', () => {
    const session = refused(newDocumentDraft('', ['']))
    expect(session.notice).toEqual({
      kind: 'invalid-address',
      message: 'Enter id and customerId for the new document.'
    })
    const edited = editSessionReducer(session, {
      type: 'newDocumentFieldsChanged',
      fields: { id: '', partitionKey: ['TEST_CODE'] }
    })
    expect(edited.notice).toBeUndefined()
    expect(refused(edited).notice).toEqual({
      kind: 'invalid-address',
      message: 'Enter id for the new document.'
    })
  })

  it('clears a Create refusal once the body is edited', () => {
    const session = refused(newDocumentDraft('n1', ['c9'], { id: 'n2' }))
    expect(session.notice?.kind).toBe('invalid-address')
    expect(editSessionReducer(session, { type: 'draftChanged', text: '{}' }).notice).toBeUndefined()
  })

  it('keeps an id clash notice when the fields are edited, so Open existing stays available', () => {
    let session = newDocumentDraft('n1', ['c9'])
    session = editSessionReducer(session, {
      type: 'saveStarted',
      address: { id: 'n1', partitionKey: 'c9' }
    })
    session = editSessionReducer(session, { type: 'saveOutcome', outcome: 'conflict', requestCharge: 1 })
    const clash = session.notice
    expect(clash?.kind).toBe('id-clash')
    const edited = editSessionReducer(session, {
      type: 'newDocumentFieldsChanged',
      fields: { id: 'n2', partitionKey: ['c9'] }
    })
    expect(edited.notice).toEqual(clash)
  })
})

describe('creating a New document', () => {
  const created = {
    id: 'n1',
    customerId: 'c9',
    name: 'Grace',
    _rid: 'rid-9',
    _self: 's',
    _etag: '"etag-new"',
    _attachments: 'attachments/',
    _ts: 1_700_000_200
  }

  function creating(): EditSession {
    return editSessionReducer(newDocumentDraft('n1', ['c9'], { name: 'Grace' }), {
      type: 'saveStarted',
      address: { id: 'n1', partitionKey: 'c9' }
    })
  }

  it('becomes an edit session of the created document, showing its RU charge', () => {
    const session = editSessionReducer(creating(), {
      type: 'saveSucceeded',
      document: created,
      requestCharge: 6.29
    })
    expect(session).toMatchObject({
      newDocument: undefined,
      phase: 'editing',
      saving: false,
      address: { id: 'n1', partitionKey: 'c9' },
      etag: '"etag-new"',
      serverCopy: created,
      notice: { kind: 'created', requestCharge: 6.29 }
    })
    expect(JSON.parse(session.draft)).toEqual({ name: 'Grace' })
    expect(hasUnsavedEdits(session)).toBe(false)

    const edited = editSessionReducer(session, { type: 'draftChanged', text: '{"name":"Grace Hopper"}' })
    expect(planSave(edited)).toMatchObject({ ok: true, write: { kind: 'replace', ifMatch: '"etag-new"' } })
  })

  it('keeps the draft and fields on an id clash and names the address that clashed', () => {
    const session = editSessionReducer(creating(), {
      type: 'saveOutcome',
      outcome: 'conflict',
      requestCharge: 1.1
    })
    expect(session).toMatchObject({
      saving: false,
      newDocument: { id: 'n1', partitionKey: ['c9'] },
      notice: { kind: 'id-clash', address: { id: 'n1', partitionKey: 'c9' } }
    })
    expect(JSON.parse(session.draft)).toEqual({ name: 'Grace' })
    expect(hasUnsavedEdits(session)).toBe(true)
  })
})

describe('edit sessions after an id clash', () => {
  const clash = { id: 'a1', partitionKey: 'c9' }

  function clashed(): EditSessionsState {
    let state = editSessionsReducer(initialEditSessionsState, {
      type: 'newDocumentOpened',
      key: 1,
      target,
      partitionKeyPaths: ['/customerId']
    })
    const events: EditSessionEvent[] = [
      { type: 'newDocumentFieldsChanged', fields: { id: 'a1', partitionKey: ['c9'] } },
      { type: 'draftChanged', text: '{"name":"Mine"}' },
      { type: 'saveStarted', address: clash },
      { type: 'saveOutcome', outcome: 'conflict', requestCharge: 1 }
    ]
    for (const event of events) state = editSessionsReducer(state, { type: 'session', key: 1, event })
    return state
  }

  it('Open existing opens the clashing document in a new edit session tab next to the draft', () => {
    const before = clashed()
    const state = editSessionsReducer(before, {
      type: 'opened',
      key: 2,
      target,
      partitionKeyPaths: ['/customerId'],
      address: clash,
      row: undefined
    })
    expect(state.sessions.map((s) => s.key)).toEqual([1, 2])
    expect(state.activeKey).toBe(2)
    expect(state.sessions[1]).toMatchObject({ phase: 'reading', address: clash })
    expect(state.sessions[1].newDocument).toBeUndefined()
    expect(state.sessions[0]).toBe(before.sessions[0])
  })

  it("switching tabs keeps each session's draft and notice", () => {
    let state = editSessionsReducer(clashed(), {
      type: 'opened',
      key: 2,
      target,
      partitionKeyPaths: ['/customerId'],
      address: clash,
      row: undefined
    })
    state = editSessionsReducer(state, {
      type: 'session',
      key: 2,
      event: { type: 'readSucceeded', document: stored }
    })
    state = editSessionsReducer(state, {
      type: 'session',
      key: 2,
      event: { type: 'draftChanged', text: '{"name":"Theirs, edited"}' }
    })
    state = editSessionsReducer(state, { type: 'selected', key: 1 })
    state = editSessionsReducer(state, { type: 'selected', key: 2 })
    state = editSessionsReducer(state, { type: 'selected', key: 1 })

    expect(state.activeKey).toBe(1)
    const [draft, existing] = state.sessions
    expect(draft).toMatchObject({ draft: '{"name":"Mine"}', notice: { kind: 'id-clash' } })
    expect(existing).toMatchObject({ draft: '{"name":"Theirs, edited"}', etag: '"etag-1"' })
  })

  it('a New document draft is never mistaken for the document at its attempted address', () => {
    expect(findEditSession(clashed(), target, clash)).toBeUndefined()
  })
})

describe('hasUnsavedEdits', () => {
  it('is false for the freshly read server copy and true once the body changes', () => {
    expect(hasUnsavedEdits(editing())).toBe(false)
    expect(hasUnsavedEdits(editing(stored, { name: 'Grace' }))).toBe(true)
  })
})

function openedForDelete(row: unknown = { id: 'a1', customerId: 'c9', name: 'Ada' }): EditSession {
  return openEditSession({
    key: 1,
    target,
    partitionKeyPaths: ['/customerId'],
    address: { id: 'a1', partitionKey: 'c9' },
    row,
    mode: 'delete'
  })
}

describe('deleting a document', () => {
  it('opens Delete reading the latest version, then previews that version read-only and copyable', () => {
    const reading = openedForDelete()
    expect(reading).toMatchObject({ mode: 'delete', phase: 'reading' })

    const read = editSessionReducer(reading, { type: 'readSucceeded', document: stored })
    expect(read).toMatchObject({ mode: 'delete', phase: 'editing', etag: '"etag-1"' })
    expect(JSON.parse(deletePreviewText(read))).toEqual({ id: 'a1', customerId: 'c9', name: 'Ada' })
  })

  function previewing(): EditSession {
    return editSessionReducer(openedForDelete(), { type: 'readSucceeded', document: stored })
  }

  it('sends a delete Document Write carrying the session etag', () => {
    expect(planDelete(previewing())).toEqual({
      ok: true,
      write: {
        kind: 'delete',
        id: 'a1',
        partitionKey: 'c9',
        ifMatch: '"etag-1"',
        database: 'orders-db',
        container: 'orders'
      }
    })
  })

  it('sends nothing before the latest version has been read', () => {
    expect(planDelete(openedForDelete())).toMatchObject({ ok: false })
  })

  function deletingIn(): EditSessionsState {
    const state = editSessionsReducer(initialEditSessionsState, {
      type: 'opened',
      key: 1,
      target,
      partitionKeyPaths: ['/customerId'],
      address: { id: 'a1', partitionKey: 'c9' },
      row: { id: 'a1', customerId: 'c9' },
      mode: 'delete'
    })
    return [
      { type: 'readSucceeded', document: stored } as const,
      { type: 'deleteStarted' } as const
    ].reduce((s, event) => editSessionsReducer(s, { type: 'session', key: 1, event }), state)
  }

  it('is busy while the delete is in flight', () => {
    expect(deletingIn().sessions[0]).toMatchObject({ saving: true, notice: undefined })
  })

  it('closes the edit session once deleted and toasts the id and RU charge', () => {
    const state = editSessionsReducer(deletingIn(), {
      type: 'session',
      key: 1,
      event: { type: 'deleteSucceeded', requestCharge: 5.71 }
    })
    expect(state).toMatchObject({ sessions: [], activeKey: undefined, toast: { key: 1, message: 'Deleted a1 · 5.71 RU' } })
  })

  it('treats a 404 on delete as done, noting the document was already deleted', () => {
    const state = editSessionsReducer(deletingIn(), {
      type: 'session',
      key: 1,
      event: { type: 'deleteOutcome', outcome: 'not-found', requestCharge: 1.1 }
    })
    expect(state).toMatchObject({
      sessions: [],
      toast: { key: 1, message: 'This document was already deleted.' }
    })
  })

  it('clears the toast once shown', () => {
    const deleted = editSessionsReducer(deletingIn(), {
      type: 'session',
      key: 1,
      event: { type: 'deleteSucceeded', requestCharge: 5.71 }
    })
    expect(editSessionsReducer(deleted, { type: 'toastShown', key: 1 }).toast).toBeUndefined()
  })

  function changedBeforeDelete(): EditSession {
    return [
      { type: 'deleteStarted' } as const,
      { type: 'deleteOutcome', outcome: 'precondition-failed', requestCharge: 1.24 } as const
    ].reduce(editSessionReducer, previewing())
  }

  it('aborts the delete on a Concurrent Change and offers no delete anyway', () => {
    const refused = changedBeforeDelete()
    expect(refused).toMatchObject({
      mode: 'delete',
      phase: 'editing',
      saving: false,
      notice: { kind: 'concurrent-change-on-delete' }
    })
    expect(planDelete(refused)).toMatchObject({ ok: false })
  })

  it('Review current version reads the current version into the preview, and Delete then carries its etag', () => {
    const reviewing = editSessionReducer(changedBeforeDelete(), { type: 'reviewRequested' })
    expect(reviewing).toMatchObject({ mode: 'delete', phase: 'reading', notice: undefined })

    const current = { ...stored, name: 'Ada Byron', _etag: '"etag-3"' }
    const reviewed = editSessionReducer(reviewing, { type: 'readSucceeded', document: current })
    expect(JSON.parse(deletePreviewText(reviewed))).toMatchObject({ name: 'Ada Byron' })
    expect(planDelete(reviewed)).toMatchObject({ ok: true, write: { kind: 'delete', ifMatch: '"etag-3"' } })
  })

  it('keeps the preview and shows the scrubbed message of an unexpected delete error', () => {
    const failed = [
      { type: 'deleteStarted' } as const,
      { type: 'deleteFailed', message: 'Request timed out' } as const
    ].reduce(editSessionReducer, previewing())
    expect(failed).toMatchObject({ phase: 'editing', saving: false, notice: { kind: 'error', message: 'Request timed out' } })
    expect(planDelete(failed)).toMatchObject({ ok: true })
  })

  it('Edit instead edits the version just read, saving with its etag', () => {
    const editingInstead = editSessionReducer(previewing(), { type: 'editRequested' })
    expect(editingInstead).toMatchObject({ mode: 'edit', phase: 'editing' })
    const changed = editSessionReducer(editingInstead, {
      type: 'draftChanged',
      text: JSON.stringify({ name: 'Grace' })
    })
    expect(planSave(changed)).toMatchObject({ ok: true, write: { kind: 'replace', ifMatch: '"etag-1"' } })
  })
})

describe('Edit and Delete on a document already open in the drawer', () => {
  const open = (key: number, mode: 'edit' | 'delete'): EditSessionsAction => ({
    type: 'opened',
    key,
    target,
    partitionKeyPaths: ['/customerId'],
    address: { id: 'a1', partitionKey: 'c9' },
    row: { id: 'a1', customerId: 'c9' },
    mode
  })
  const read: EditSessionsAction = {
    type: 'session',
    key: 1,
    event: { type: 'readSucceeded', document: stored }
  }

  it('Delete turns the open edit session into a Delete that reads the latest version again', () => {
    const state = [open(1, 'edit'), read, open(2, 'delete')].reduce(
      editSessionsReducer,
      initialEditSessionsState
    )
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({ key: 1, mode: 'delete', phase: 'reading', etag: undefined })
    expect(state.activeKey).toBe(1)
  })

  it('Delete keeps an edit session with unsaved edits as it is and says why', () => {
    const draft: EditSessionsAction = {
      type: 'session',
      key: 1,
      event: { type: 'draftChanged', text: JSON.stringify({ name: 'Grace' }) }
    }
    const state = [open(1, 'edit'), read, draft, open(2, 'delete')].reduce(
      editSessionsReducer,
      initialEditSessionsState
    )
    expect(state.sessions[0]).toMatchObject({
      mode: 'edit',
      phase: 'editing',
      notice: { kind: 'error', message: 'Save or discard your edits before deleting this document.' }
    })
    expect(JSON.parse(state.sessions[0].draft)).toEqual({ name: 'Grace' })
  })

  it('Edit turns an open Delete into editing the version already read', () => {
    const state = [open(1, 'delete'), read, open(2, 'edit')].reduce(
      editSessionsReducer,
      initialEditSessionsState
    )
    expect(state.sessions[0]).toMatchObject({ key: 1, mode: 'edit', phase: 'editing', etag: '"etag-1"' })
  })
})
