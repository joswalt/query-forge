import { useEffect, useRef } from 'react'
import { WRITE_OUTCOMES, writeOutcomeLabel } from '@shared/types/dml-run'
import type { DmlRunState } from './dml-run-state'
import './dml-run.css'

const count = (n: number): string => n.toLocaleString()
const ru = (n: number): string => n.toFixed(2)
const documents = (n: number): string => `${count(n)} document${n === 1 ? '' : 's'}`

/**
 * The DML confirmation strip, docked under the editor toolbar so the
 * statement stays visible (story 80). Every Environment confirms (story
 * 82); focus starts on Cancel so Enter cancels (story 90). `blockedShortcut`
 * changes each time Cmd/Ctrl+Enter was swallowed, flashing the hint (story
 * 91).
 */
export function DmlConfirmStrip({
  dml,
  blockedShortcut,
  onConfirm,
  onCancel
}: {
  dml: DmlRunState | undefined
  blockedShortcut: number
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (dml?.phase !== 'confirming') return null
  const verbs = dml.verb === 'DELETE' ? 'Deletes' : 'Updates'
  const action = dml.verb === 'DELETE' ? 'Delete' : 'Update'
  return (
    <div className="dml-strip" role="alertdialog" aria-label="Confirm DML Statement">
      <div className="dml-strip__line">
        <span className="dml-strip__icon" aria-hidden="true">
          !
        </span>
        <span>
          <b>
            {verbs} {documents(dml.matchCount)}
          </b>{' '}
          in <code>{dml.container}</code>
        </span>
        <span className="dml-muted">Driving Query {ru(dml.drivingQueryRequestCharge)} RU</span>
      </div>
      <div className="dml-strip__line">
        <ShortcutHint blocked={blockedShortcut} />
        <span className="dml-spacer" />
        <button type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="dml-danger" onClick={onConfirm}>
          {action} {documents(dml.matchCount)}
        </button>
      </div>
    </div>
  )
}

function ShortcutHint({ blocked }: { blocked: number }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useRef(blocked)
  useEffect(() => {
    if (blocked === seen.current || !ref.current) return
    seen.current = blocked
    ref.current.classList.remove('is-flash')
    void ref.current.offsetWidth
    ref.current.classList.add('is-flash')
  }, [blocked])
  return (
    <span ref={ref} className="dml-hint">
      ⌘↵ / Ctrl+Enter won’t confirm. Click the button, or Tab to it and press Enter.
    </span>
  )
}

/**
 * Above the results: planning progress with Cancel (story 76), the run
 * report while committing and after (stories 97, 99, 109), and the
 * end notices for zero matches (story 79) and a discarded plan (story 94).
 * Outcome rows themselves stream into the ordinary results grid below.
 */
export function DmlRunReport({
  dml,
  onCancel
}: {
  dml: DmlRunState | undefined
  onCancel: () => void
}): React.JSX.Element | null {
  if (!dml) return null
  switch (dml.phase) {
    case 'planning':
      return (
        <div className="dml-notice" role="status">
          <span className="dml-spinner" aria-hidden="true" /> Finding matching documents in{' '}
          <code>{dml.container}</code>… {count(dml.matched)} so far · {ru(dml.requestCharge)} RU
          <span className="dml-spacer" />
          <button type="button" className="btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )
    case 'zero-matches':
      return (
        <div className="dml-notice" role="status">
          No documents match. Nothing to write.
          <span className="dml-muted">
            Driving Query {ru(dml.drivingQueryRequestCharge)} RU
          </span>
        </div>
      )
    case 'discarded':
      return (
        <div className="dml-notice" role="status">
          Cancelled. Nothing was written to <code>{dml.container}</code>.
        </div>
      )
    case 'committing':
    case 'done':
    case 'stopped':
      return <CommitReport dml={dml} onStop={onCancel} />
    default:
      return null
  }
}

function CommitReport({
  dml,
  onStop
}: {
  dml: Extract<DmlRunState, { phase: 'committing' | 'done' | 'stopped' }>
  onStop: () => void
}): React.JSX.Element {
  const past = dml.verb === 'DELETE' ? 'deleted' : 'updated'
  const ing = dml.verb === 'DELETE' ? 'Deleting' : 'Updating'
  let head: string
  let completed: number
  let total: number
  let requestCharge: number
  let counts: Partial<Record<(typeof WRITE_OUTCOMES)[number], number>> | undefined
  if (dml.phase === 'committing') {
    ;({ completed, total } = dml.progress)
    requestCharge = dml.drivingQueryRequestCharge + dml.progress.requestCharge
    head = `${dml.stopRequested ? 'Stopping after in-flight writes' : ing}… ${count(completed)} of ${count(total)}`
  } else {
    const { summary } = dml
    counts = summary.counts
    total = dml.matchCount
    completed = total
    requestCharge = summary.drivingQueryRequestCharge + summary.writeRequestCharge
    head = `${dml.phase === 'stopped' ? 'Stopped' : 'Done'}: ${past} ${count(summary.counts.written)} of ${count(total)}`
  }
  const duration = dml.phase === 'committing' ? undefined : dml.summary.durationMs
  return (
    <div className="dml-report" role="status">
      <div className="dml-report__head">
        <b>{head}</b>
        <span className="dml-muted">
          {ru(requestCharge)} RU
          {duration !== undefined && ` · ${(duration / 1000).toFixed(1)} s`}
        </span>
        <span className="dml-spacer" />
        {dml.phase === 'committing' && (
          <button type="button" disabled={dml.stopRequested} onClick={onStop}>
            Stop
          </button>
        )}
      </div>
      <div
        className="dml-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
      >
        <span style={{ width: `${total > 0 ? (completed / total) * 100 : 100}%` }} />
      </div>
      {counts && (
        <p className="dml-counts">
          {WRITE_OUTCOMES.filter((o) => (counts?.[o] ?? 0) > 0)
            .map((o) => `${writeOutcomeLabel(o, dml.verb)}: ${count(counts?.[o] ?? 0)}`)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}
