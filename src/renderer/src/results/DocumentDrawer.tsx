import { useEffect, useState } from 'react'
import type { PartitionKeyLevelValue } from '@shared/types/document-writer'
import { JsonEditor } from '../editor/JsonEditor'
import { partitionKeyFieldName } from './addressable-row'
import {
  deletePreviewText,
  hasUnsavedEdits,
  SYSTEM_PROPERTIES,
  type EditNotice,
  type EditSession,
  type EditSessionsState
} from './edit-session'

export interface DocumentDrawerProps {
  state: EditSessionsState
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
  /** "Different address? New document"; inert until New document exists. */
  onNewDocument?: () => void
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
  const title = session.mode === 'delete' ? 'Delete document' : 'Edit document'

  return (
    <aside className="document-drawer" role="dialog" aria-label={title}>
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
              {s.address.id}
              {hasUnsavedEdits(s) ? ' •' : ''}
            </button>
          ))}
        </div>
      )}
      <header className="document-drawer__head">
        <strong>{title}</strong>
        <code className="document-drawer__id">{session.address.id}</code>
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

function SessionBody(props: DocumentDrawerProps & { session: EditSession }): React.JSX.Element {
  const { session, onClose, onDraftChange, onSave, onNewDocument } = props
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
      return (
        <div className="document-drawer__body">
          <AddressChips session={session} onNewDocument={onNewDocument} />
          {session.notice && <Notice notice={session.notice} />}
          <JsonEditor
            key={`${session.key}:${session.revision}`}
            initialValue={session.draft}
            ariaLabel={`Body of ${session.address.id}`}
            onChange={(text) => onDraftChange(session.key, text)}
          />
          <SystemProperties document={session.serverCopy} />
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
              {session.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )
    }
  }
}

/**
 * Delete mode (stories 52, 60): a read-only, copyable preview of the version
 * just read, with an explicit Delete document button as the confirmation.
 * After a Concurrent Change only Review current version is offered; there is
 * no delete anyway.
 */
function DeletePreview({
  session,
  onClose,
  onDelete,
  onReview,
  onEditInstead
}: DocumentDrawerProps & { session: EditSession }): React.JSX.Element {
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
        <button type="button" disabled={session.saving} onClick={() => onEditInstead(session.key)}>
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
            onClick={() => onDelete(session.key)}
          >
            {session.saving ? 'Deleting…' : 'Delete document'}
          </button>
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
  onNewDocument?: () => void
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
        aria-disabled={onNewDocument ? undefined : true}
        onClick={() => onNewDocument?.()}
      >
        Different address? New document
      </button>
    </div>
  )
}

function Notice({ notice }: { notice: EditNotice }): React.JSX.Element {
  switch (notice.kind) {
    case 'saved':
      return (
        <p className="document-drawer__notice document-drawer__notice--ok" role="status">
          Saved · {notice.requestCharge.toFixed(2)} RU
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
