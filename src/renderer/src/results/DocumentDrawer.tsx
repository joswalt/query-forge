import type { PartitionKeyLevelValue } from '@shared/types/document-writer'
import { JsonEditor } from '../editor/JsonEditor'
import { partitionKeyFieldName } from './addressable-row'
import {
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
              {s.address.id}
              {hasUnsavedEdits(s) ? ' •' : ''}
            </button>
          ))}
        </div>
      )}
      <header className="document-drawer__head">
        <strong>Edit document</strong>
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

function SessionBody({
  session,
  onClose,
  onDraftChange,
  onSave,
  onNewDocument
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
