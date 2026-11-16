import type { PartitionKeyLevelValue, PartitionKeyValue } from '@shared/types/document-writer'
import { JsonEditor } from '../editor/JsonEditor'
import { partitionKeyFieldName, type DocumentAddress } from './addressable-row'
import {
  hasUnsavedEdits,
  parsePartitionKeyInput,
  SYSTEM_PROPERTIES,
  type EditNotice,
  type EditSession,
  type EditSessionsState,
  type NewDocumentFields
} from './edit-session'

export interface DocumentDrawerProps {
  state: EditSessionsState
  onSelect: (key: number) => void
  onClose: (key: number) => void
  onDraftChange: (key: number, text: string) => void
  onSave: (key: number) => void
  /** New document: empty, or prefilled `from` an edit session ("Different
   * address? New document"). */
  onNewDocument: (from?: number) => void
  onNewDocumentFieldsChange: (key: number, fields: NewDocumentFields) => void
  /** After an `id` clash: open the document already at `address`. */
  onOpenExisting: (key: number, address: DocumentAddress) => void
}

/**
 * The document editing drawer (decision 04, variant A): a right-side panel
 * over the results grid, one tab per edit session. Opens at once while the
 * latest version is read, then edits the body only, with the address as
 * locked chips and system properties folded away read-only.
 */
export function DocumentDrawer(props: DocumentDrawerProps): React.JSX.Element | null {
  const { state } = props
  const session = state.sessions.find((s) => s.key === state.activeKey)
  if (!session) return null

  return (
    <aside className="document-drawer" role="dialog" aria-label="Edit document">
      {state.sessions.length > 1 && (
        <div className="document-drawer__tabs" role="tablist" aria-label="Open documents">
          {state.sessions.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={s.key === session.key}
              onClick={() => props.onSelect(s.key)}
            >
              {s.newDocument ? 'New document' : s.address.id}
              {hasUnsavedEdits(s) ? ' •' : ''}
            </button>
          ))}
        </div>
      )}
      <header className="document-drawer__head">
        <strong>{session.newDocument ? 'New document' : 'Edit document'}</strong>
        {!session.newDocument && <code className="document-drawer__id">{session.address.id}</code>}
        <span className="document-drawer__spacer" />
        <button
          type="button"
          className="btn--ghost"
          aria-label="Close"
          title="Close"
          onClick={() => props.onClose(session.key)}
        >
          ✕
        </button>
      </header>
      <SessionBody {...props} session={session} />
    </aside>
  )
}

function SessionBody({
  session,
  onClose,
  onDraftChange,
  onSave,
  onNewDocument,
  onNewDocumentFieldsChange,
  onOpenExisting
}: DocumentDrawerProps & { session: EditSession }): React.JSX.Element {
  switch (session.phase) {
    case 'reading':
      return (
        <div className="document-drawer__state" role="status">
          <span className="document-drawer__spinner" aria-hidden="true" />
          Reading the latest version of <code>{session.address.id}</code>…
        </div>
      )
    case 'missing':
      return (
        <div className="document-drawer__state" role="alert">
          <strong>This document no longer exists</strong>
          <span>It was deleted after your query ran. Re-run the query to refresh the results.</span>
        </div>
      )
    case 'out-of-date':
      return (
        <div className="document-drawer__state" role="alert">
          <strong>This row is out of date</strong>
          <span>
            The document at this id was deleted and recreated after your query ran. Re-run the
            query to edit it.
          </span>
        </div>
      )
    case 'read-failed':
      return (
        <div className="document-drawer__state" role="alert">
          <strong>The document could not be read</strong>
          {session.notice?.kind === 'error' && <span>{session.notice.message}</span>}
        </div>
      )
    case 'editing': {
      const dirty = hasUnsavedEdits(session)
      const { newDocument } = session
      return (
        <div className="document-drawer__body">
          {newDocument ? (
            <NewDocumentAddress
              session={session}
              fields={newDocument}
              onChange={(fields) => onNewDocumentFieldsChange(session.key, fields)}
            />
          ) : (
            <AddressChips session={session} onNewDocument={() => onNewDocument(session.key)} />
          )}
          {session.notice && (
            <Notice
              notice={session.notice}
              onOpenExisting={(address) => onOpenExisting(session.key, address)}
            />
          )}
          <JsonEditor
            key={`${session.key}:${session.revision}`}
            initialValue={session.draft}
            ariaLabel={newDocument ? 'Body of the new document' : `Body of ${session.address.id}`}
            onChange={(text) => onDraftChange(session.key, text)}
          />
          {!newDocument && <SystemProperties document={session.serverCopy} />}
          <div className="document-drawer__actions">
            <span className="document-drawer__spacer" />
            <button type="button" onClick={() => onClose(session.key)}>
              {dirty ? 'Discard' : 'Close'}
            </button>
            <button
              type="button"
              className="btn--primary"
              disabled={session.saving || !dirty}
              onClick={() => onSave(session.key)}
            >
              {newDocument
                ? session.saving
                  ? 'Creating…'
                  : 'Create'
                : session.saving
                  ? 'Saving…'
                  : 'Save'}
            </button>
          </div>
        </div>
      )
    }
  }
}

function levelLabel(level: PartitionKeyLevelValue): string {
  if (level === null) return 'null'
  if (typeof level === 'object') return '(none)'
  return String(level)
}

/** Locked `id` and partition key values, with the pointer to New document. */
function AddressChips({
  session,
  onNewDocument
}: {
  session: EditSession
  onNewDocument: () => void
}): React.JSX.Element {
  const paths = session.partitionKeyPaths
  const levels: PartitionKeyLevelValue[] =
    paths.length > 1 && Array.isArray(session.address.partitionKey)
      ? session.address.partitionKey
      : [session.address.partitionKey as PartitionKeyLevelValue]
  return (
    <div
      className="document-drawer__address"
      title="id and partition key can't change. To store this at a different address, use New document."
    >
      <span className="document-drawer__chip">
        <span aria-hidden="true">🔒</span> id <code>{session.address.id}</code>
      </span>
      {paths.map((path, i) => (
        <span key={path} className="document-drawer__chip">
          <span aria-hidden="true">🔒</span> {partitionKeyFieldName(path)}{' '}
          <code>{levelLabel(levels[i])}</code>
        </span>
      ))}
      <button
        type="button"
        className="btn--ghost document-drawer__link"
        title="Open a New document with this body, at an id and partition key you choose"
        onClick={onNewDocument}
      >
        Different address? New document
      </button>
    </div>
  )
}

/** What a partition key field's text will be sent as, so `72712` (a number)
 * and `"72712"` (a string) are told apart before Create. */
function valueKind(text: string): string {
  if (text === '') return ''
  const value = parsePartitionKeyInput(text)
  return value === null ? 'null' : typeof value
}

/** New document's editable `id` and partition key fields (story 26), one
 * per level of a hierarchical key. */
function NewDocumentAddress({
  session,
  fields,
  onChange
}: {
  session: EditSession
  fields: NewDocumentFields
  onChange: (fields: NewDocumentFields) => void
}): React.JSX.Element {
  const clashed = session.notice?.kind === 'id-clash'
  return (
    <div className="document-drawer__fields">
      <label>
        <span>id</span>
        <input
          value={fields.id}
          placeholder="unique within the partition"
          aria-invalid={clashed || undefined}
          disabled={session.saving}
          spellCheck={false}
          onChange={(e) => onChange({ ...fields, id: e.target.value })}
        />
      </label>
      {session.partitionKeyPaths.map((path, i) => {
        const text = fields.partitionKey[i] ?? ''
        return (
          <label key={path}>
            <span>
              {partitionKeyFieldName(path)}{' '}
              <span className="document-drawer__muted">
                (partition key{session.partitionKeyPaths.length > 1 ? `, level ${i + 1}` : ''})
              </span>
            </span>
            <input
              value={text}
              placeholder='text, or a JSON number, true, false, null or "quoted string"'
              disabled={session.saving}
              spellCheck={false}
              onChange={(e) => {
                const partitionKey = [...fields.partitionKey]
                partitionKey[i] = e.target.value
                onChange({ ...fields, partitionKey })
              }}
            />
            <span className="document-drawer__muted document-drawer__kind">{valueKind(text)}</span>
          </label>
        )
      })}
    </div>
  )
}

/** A partition key value as the user reads it in a message. */
function partitionKeyLabel(value: PartitionKeyValue): string {
  return Array.isArray(value) ? `[${value.map(levelLabel).join(', ')}]` : levelLabel(value)
}

function Notice({
  notice,
  onOpenExisting
}: {
  notice: EditNotice
  onOpenExisting: (address: DocumentAddress) => void
}): React.JSX.Element {
  switch (notice.kind) {
    case 'saved':
      return (
        <p className="document-drawer__notice document-drawer__notice--ok" role="status">
          Saved · {notice.requestCharge.toFixed(2)} RU
        </p>
      )
    case 'created':
      return (
        <p className="document-drawer__notice document-drawer__notice--ok" role="status">
          Created · {notice.requestCharge.toFixed(2)} RU
        </p>
      )
    case 'id-clash':
      return (
        <p className="document-drawer__notice document-drawer__notice--error" role="alert">
          A document with id <code>{notice.address.id}</code> already exists in partition{' '}
          <code>{partitionKeyLabel(notice.address.partitionKey)}</code>.{' '}
          <button type="button" onClick={() => onOpenExisting(notice.address)}>
            Open existing
          </button>
        </p>
      )
    case 'invalid-address':
      return (
        <p className="document-drawer__notice document-drawer__notice--error" role="alert">
          {notice.message}
        </p>
      )
    case 'address-changed':
      return (
        <p className="document-drawer__notice document-drawer__notice--error" role="alert">
          {notice.fields.join(' and ')} can&apos;t change here. To store this at a different
          address, use New document.
        </p>
      )
    case 'invalid-body':
      return (
        <p className="document-drawer__notice document-drawer__notice--error" role="alert">
          The body must be a JSON object: {notice.message}
        </p>
      )
    case 'concurrent-change':
      return (
        <p className="document-drawer__notice document-drawer__notice--warn" role="alert">
          This document changed since you opened it.
        </p>
      )
    case 'deleted-while-editing':
      return (
        <p className="document-drawer__notice document-drawer__notice--warn" role="alert">
          This document was deleted since you opened it.
        </p>
      )
    case 'error':
      return (
        <p className="document-drawer__notice document-drawer__notice--error" role="alert">
          {notice.message}
        </p>
      )
  }
}

function SystemProperties({
  document
}: {
  document: Record<string, unknown> | undefined
}): React.JSX.Element | null {
  if (!document) return null
  return (
    <details className="document-drawer__system">
      <summary>System properties</summary>
      <dl>
        {SYSTEM_PROPERTIES.map((key) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <code>{document[key] === undefined ? '' : String(document[key])}</code>
              {key === '_ts' && typeof document._ts === 'number' && (
                <span className="document-drawer__muted">
                  {' '}
                  {new Date(document._ts * 1000).toLocaleString()}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
