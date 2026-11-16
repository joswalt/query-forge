import { JsonEditor } from '../editor/JsonEditor'
import { editorText, hasUnsavedEdits, isBusy, type EditSession } from './edit-session'
import { ConfirmWriteButtons, type WriteConfirmationStep } from './WriteConfirmation'

type DiffLine = { kind: 'same' | 'server' | 'mine'; text: string }

/** A line diff of two texts, aligned for side-by-side display: a line only
 * on one side faces a gap (null) on the other. */
function lineDiff(a: string[], b: string[]): { left: (DiffLine | null)[]; right: (DiffLine | null)[] } {
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const left: (DiffLine | null)[] = []
  const right: (DiffLine | null)[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      left.push({ kind: 'same', text: a[i++] })
      right.push({ kind: 'same', text: b[j++] })
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      left.push(null)
      right.push({ kind: 'mine', text: b[j++] })
    } else {
      left.push({ kind: 'server', text: a[i++] })
      right.push(null)
    }
  }
  return { left, right }
}

/** My draft, pretty-printed like the server side when it parses. */
function mineText(draft: string): string {
  try {
    return JSON.stringify(JSON.parse(draft), null, 2)
  } catch {
    return draft
  }
}

function DiffColumn({ label, lines }: { label: string; lines: (DiffLine | null)[] }): React.JSX.Element {
  return (
    <div className="document-compare__col">
      <div className="document-compare__label">{label}</div>
      <pre className="document-compare__diff" aria-label={label}>
        {lines.map((line, i) => (
          <div key={i} className={`document-compare__line is-${line?.kind ?? 'gap'}`}>
            {line?.text ?? ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

/**
 * The compare view (stories 38 to 41): the server copy as Compare read it
 * next to my draft, which stays editable. Save carries that read's etag;
 * Overwrite with mine reads the current version again and replaces it.
 * Both are Document Writes, so on prod they take a Write Confirmation.
 */
export function CompareView({
  session,
  confirmation,
  notice,
  onDraftChange,
  onBackToEditor,
  onSave,
  onOverwrite
}: {
  session: EditSession
  confirmation: WriteConfirmationStep
  notice: React.ReactNode
  onDraftChange: (text: string) => void
  onBackToEditor: () => void
  onSave: () => void
  onOverwrite: () => void
}): React.JSX.Element {
  const busy = isBusy(session)
  const server = session.serverCopy ? editorText(session.serverCopy, session.partitionKeyPaths) : ''
  const { left, right } = lineDiff(server.split('\n'), mineText(session.draft).split('\n'))
  const awaiting = confirmation.awaiting
  return (
    <div className="document-drawer__body document-compare">
      {notice}
      <p className="document-drawer__muted" role="status">
        {session.pendingRead === 'compare'
          ? 'Reading the current version…'
          : session.pendingRead === 'overwrite'
            ? 'Reading the current version to overwrite…'
            : 'Server now (read just now) vs your edits. Save applies your side if nobody changes it first.'}
      </p>
      <div className="document-compare__cols">
        <DiffColumn label="Server now" lines={left} />
        <DiffColumn label="Mine" lines={right} />
      </div>
      <details className="document-compare__edit" open>
        <summary>Edit my side</summary>
        <JsonEditor
          key={`${session.key}:${session.revision}:compare`}
          initialValue={session.draft}
          ariaLabel={`My version of ${session.address.id}`}
          onChange={onDraftChange}
        />
      </details>
      <div className="document-drawer__actions">
        {awaiting === 'save' || awaiting === 'overwrite' ? (
          <>
            <span className="document-drawer__spacer" />
            <ConfirmWriteButtons
              step={confirmation}
              write={awaiting}
              onConfirm={awaiting === 'save' ? onSave : onOverwrite}
            />
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={onBackToEditor}>
              Back to editor
            </button>
            <span className="document-drawer__spacer" />
            <button
              type="button"
              disabled={busy}
              title="Reads the current version again and replaces it with yours"
              onClick={() => confirmation.press('overwrite', onOverwrite)}
            >
              Overwrite with mine
            </button>
            <button
              type="button"
              className="btn--primary"
              disabled={busy || !hasUnsavedEdits(session)}
              onClick={() => confirmation.press('save', onSave)}
            >
              {session.saving ? 'Saving…' : confirmation.required ? 'Save to prod' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
