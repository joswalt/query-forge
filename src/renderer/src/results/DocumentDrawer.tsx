import { useEffect, useState } from 'react'
import type { ConnectionEnvironment } from '@shared/types/connection-profile'
import type { PartitionKeyLevelValue, PartitionKeyValue } from '@shared/types/document-writer'
import { JsonEditor } from '../editor/JsonEditor'
import { partitionKeyFieldName, type DocumentAddress } from './addressable-row'
import {
  deletePreviewText,
  hasUnsavedEdits,
  parsePartitionKeyInput,
  SYSTEM_PROPERTIES,
  type EditNotice,
  type EditSession,
  type EditSessionsState,
  type NewDocumentFields
} from './edit-session'
import {
  ConfirmWriteButtons,
  isSaveShortcut,
  ProdWriteStrip,
  useWriteConfirmation,
  type WriteConfirmationStep
} from './WriteConfirmation'

export interface DocumentDrawerProps {
  state: EditSessionsState
  /** The Connection Profile the documents are written to, as it is now
   * (looked up on every render, never cached), for the Write Confirmation
   * policy and the prod header strip. */
  connectionProfile: { environment?: ConnectionEnvironment } | undefined
  onSelect: (key: number) => void
  onClose: (key: number) => void
  onDraftChange: (key: number, text: string) => void
  onSave: (key: number) => void
  /** Delete document in a delete-mode session: sends the delete. */
  onDelete: (key: number) => void
  /** Review current version after a Concurrent Change on Delete. */
  onReview: (key: number) => void
  /** Edit instead: switch a delete-mode session to editing. */
  onEditInstead: (key: number) => void
  /** The finished delete's toast has been shown. */
  onToastShown: (key: number) => void
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
 * locked chips and system properties folded away read-only. On a prod
 * Connection Profile every write takes a Write Confirmation (decision 05).
 */
export function DocumentDrawer(props: DocumentDrawerProps): React.JSX.Element | null {
  const { state } = props
  const session = state.sessions.find((s) => s.key === state.activeKey)
  const confirmation = useWriteConfirmation(props.connectionProfile, session)
  if (!session) return null
  const title = session.newDocument
    ? 'New document'
    : session.mode === 'delete'
      ? 'Delete document'
      : 'Edit document'

  return (
    <aside
      className="document-drawer"
      role="dialog"
      aria-label={title}
      data-env={confirmation.required ? 'prod' : undefined}
      onKeyDown={(event) => {
        if (!isSaveShortcut(event)) return
        // Cmd/Ctrl+S is Save or Create, never Delete; on prod it is only the
        // first step (story 56).
        event.preventDefault()
        if (canSave(session)) confirmation.press('save', () => props.onSave(session.key))
      }}
    >
      {confirmation.required && <ProdWriteStrip />}
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
        <strong>{title}</strong>
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
      <SessionBody {...props} session={session} confirmation={confirmation} />
    </aside>
  )
}

/** Save or Create can be pressed: an edit-mode session with unsaved edits. */
function canSave(session: EditSession): boolean {
  return (
    session.phase === 'editing' &&
    session.mode !== 'delete' &&
    !session.saving &&
    hasUnsavedEdits(session)
  )
}

type SessionBodyProps = DocumentDrawerProps & {
  session: EditSession
  confirmation: WriteConfirmationStep
}

function SessionBody(props: SessionBodyProps): React.JSX.Element {
  const {
    session,
    confirmation,
    onClose,
    onDraftChange,
    onSave,
    onNewDocument,
    onNewDocumentFieldsChange,
    onOpenExisting
  } = props
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
    case 'deleted':
      return (
        <div className="document-drawer__state" role="status">
          Deleted <code>{session.address.id}</code>
        </div>
      )
    case 'editing': {
      if (session.mode === 'delete') return <DeletePreview {...props} />
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
            {confirmation.awaiting === 'save' ? (
              <ConfirmWriteButtons
                step={confirmation}
                write="save"
                onConfirm={() => onSave(session.key)}
              />
            ) : (
              <>
                <button type="button" onClick={() => onClose(session.key)}>
                  {dirty ? 'Discard' : 'Close'}
                </button>
                <button
                  type="button"
                  className="btn--primary"
                  disabled={!canSave(session)}
                  onClick={() => confirmation.press('save', () => onSave(session.key))}
                >
                  {session.saving
                    ? newDocument
                      ? 'Creating…'
                      : 'Saving…'
                    : confirmation.required
                      ? 'Save to prod'
                      : newDocument
                        ? 'Create'
                        : 'Save'}
                </button>
              </>
            )}
          </div>
        </div>
      )
    }
  }
}

/**
 * Delete mode (stories 52, 60): a read-only, copyable preview of the version
 * just read, with an explicit Delete document button as the confirmation.
 * On prod the button reads Delete from prod and takes a Write Confirmation.
 * After a Concurrent Change only Review current version is offered; there is
 * no delete anyway.
 */
function DeletePreview({
  session,
  confirmation,
  onClose,
  onDelete,
  onReview,
  onEditInstead
}: SessionBodyProps): React.JSX.Element {
  const text = deletePreviewText(session)
  const changed = session.notice?.kind === 'concurrent-change-on-delete'
  const [copied, setCopied] = useState<'copied' | 'failed' | undefined>(undefined)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(undefined), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  function copy(): void {
    navigator.clipboard.writeText(text).then(
      () => setCopied('copied'),
      () => setCopied('failed')
    )
  }

  return (
    <div className="document-drawer__body">
      {session.notice && <Notice notice={session.notice} />}
      <p className="document-drawer__muted">
        Deletes this version, read just now. If someone changes it first, the delete stops. There
        is no undo: copy the document first if you want a backup.
      </p>
      <JsonEditor
        key={`${session.key}:${session.revision}:preview`}
        initialValue={text}
        readOnly
        ariaLabel={`Document ${session.address.id} to delete`}
      />
      <div className="document-drawer__copy">
        <button type="button" className="btn--ghost" onClick={copy}>
          Copy JSON
        </button>
        {copied && (
          <span className="document-drawer__muted" role="status">
            {copied === 'copied' ? 'Copied' : 'Copy failed'}
          </span>
        )}
      </div>
      <SystemProperties document={session.serverCopy} />
      <div className="document-drawer__actions">
        {confirmation.awaiting === 'delete' && !changed ? (
          <>
            <span className="document-drawer__spacer" />
            <ConfirmWriteButtons
              step={confirmation}
              write="delete"
              onConfirm={() => onDelete(session.key)}
            />
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={session.saving}
              onClick={() => onEditInstead(session.key)}
            >
              Edit instead
            </button>
            <span className="document-drawer__spacer" />
            <button type="button" onClick={() => onClose(session.key)}>
              Cancel
            </button>
            {changed ? (
              <button type="button" className="btn--primary" onClick={() => onReview(session.key)}>
                Review current version
              </button>
            ) : (
              <button
                type="button"
                className="btn--danger"
                disabled={session.saving}
                onClick={() => confirmation.press('delete', () => onDelete(session.key))}
              >
                {session.saving
                  ? 'Deleting…'
                  : confirmation.required
                    ? 'Delete from prod'
                    : 'Delete document'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
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
  onOpenExisting?: (address: DocumentAddress) => void
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
          {onOpenExisting && (
            <button type="button" onClick={() => onOpenExisting(notice.address)}>
              Open existing
            </button>
          )}
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
    case 'concurrent-change-on-delete':
      return (
        <p className="document-drawer__notice document-drawer__notice--warn" role="alert">
          This document changed since you opened it. Nothing was deleted; review the current
          version before deciding again.
        </p>
      )
    case 'deleted':
      return (
        <p className="document-drawer__notice document-drawer__notice--ok" role="status">
          {notice.alreadyDeleted
            ? 'This document was already deleted.'
            : `Deleted · ${notice.requestCharge.toFixed(2)} RU`}
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
