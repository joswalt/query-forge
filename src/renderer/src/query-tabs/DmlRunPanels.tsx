import { useEffect, useRef, useState } from 'react'
import type { DmlVerb } from '@shared/dml/dml-statement'
import {
  notWrittenCount,
  WRITE_OUTCOMES,
  writeOutcomeLabel,
  writeOutcomeMeaning,
  type DmlSampleDocument,
  type DmlSampleValue,
  type WriteOutcome
} from '@shared/types/dml-run'
import { matchesTypedDmlConfirmation, typedDmlConfirmation } from '@shared/write-confirmation'
import { retryScope, type DmlRunState } from './dml-run-state'
import { projectedRequestCharge, writeRequestChargeBand } from './dml-ru-estimate'
import { outcomeBarSegments, writeOutcomeTone } from './dml-run-report'
import './dml-run.css'

const count = (n: number): string => n.toLocaleString()
const ru = (n: number): string => n.toFixed(2)
/** RU for estimates and running totals: `21k`, `1.2k`, `640.25`. */
const ruCompact = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(2)
const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
const documents = (n: number): string => `${count(n)} document${n === 1 ? '' : 's'}`

/** The confirm button names the action (story 93): "Delete 1,840
 * documents", "Update 1,840 documents in prod". */
function confirmLabel(verb: DmlVerb, matchCount: number, production: boolean): string {
  const action = `${verb === 'DELETE' ? 'Delete' : 'Update'} ${documents(matchCount)}`
  if (!production) return action
  return `${action} ${verb === 'DELETE' ? 'from' : 'in'} prod`
}

/**
 * The DML confirmation strip, docked under the editor toolbar so the
 * statement stays visible (story 80). Every Environment confirms (story
 * 82); `production` (the shared Write Confirmation policy, read from the
 * current profile) turns it red and asks for the verb and count to be
 * typed first (stories 83, 84). Focus starts on Cancel so Enter cancels
 * (story 90). `blockedShortcut` changes each time Cmd/Ctrl+Enter was
 * swallowed, flashing the hint (story 91). Mount it keyed by plan, so
 * typed text never carries over to another plan.
 */
export function DmlConfirmStrip({
  dml,
  production,
  blockedShortcut,
  onConfirm,
  onCancel
}: {
  dml: DmlRunState | undefined
  production: boolean
  blockedShortcut: number
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  const [typed, setTyped] = useState('')
  if (dml?.phase !== 'confirming') return null
  const verbs = dml.verb === 'DELETE' ? 'Deletes' : 'Updates'
  const ready = !production || matchesTypedDmlConfirmation(typed, dml.verb, dml.matchCount)
  const band = writeRequestChargeBand(dml)
  return (
    <div
      className="dml-strip"
      data-env={production ? 'prod' : undefined}
      role="alertdialog"
      aria-label="Confirm DML Statement"
    >
      <div className="dml-strip__line">
        <span className="dml-strip__icon" aria-hidden="true">
          !
        </span>
        {dml.retry ? (
          <RetryLine
            verb={dml.verb}
            matchCount={dml.matchCount}
            scopeCount={dml.retry.scopeCount}
            container={dml.container}
            production={production}
          />
        ) : (
          <span>
            <b>
              {verbs} {documents(dml.matchCount)}
            </b>{' '}
            in <code>{dml.container}</code>
            {production && <b> (production)</b>}
          </span>
        )}
        <span className="dml-muted">
          Driving Query {ru(dml.drivingQueryRequestCharge)} RU
          {band && (
            <>
              {' · '}writes ≈ {ruCompact(band.low)}–{ruCompact(band.high)} RU{' '}
              <abbr title="No estimate exists before writing: this is from Microsoft's published anchors (about 5.5 RU per 1 KB insert; replace and patch about twice that). The run report projects the total from the first writes.">
                (rough)
              </abbr>
            </>
          )}
          {dml.averageDocumentSize !== undefined &&
            ` · avg document ${kilobytes(dml.averageDocumentSize)}`}
        </span>
      </div>
      <div className="dml-strip__line">
        {production && (
          <TypeToConfirm
            expected={typedDmlConfirmation(dml.verb, dml.matchCount)}
            value={typed}
            matched={ready}
            onChange={setTyped}
          />
        )}
        <ShortcutHint blocked={blockedShortcut} />
        <span className="dml-spacer" />
        <button type="button" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="dml-danger" disabled={!ready} onClick={onConfirm}>
          {confirmLabel(dml.verb, dml.matchCount, production)}
        </button>
      </div>
    </div>
  )
}

/** A Retry's confirmation line (story 119): "Retry: updates 44 documents in
 * `customers` · 3 of the 47 no longer match or were deleted, so they're
 * left alone". */
function RetryLine({
  verb,
  matchCount,
  scopeCount,
  container,
  production
}: {
  verb: DmlVerb
  matchCount: number
  scopeCount: number
  container: string
  production: boolean
}): React.JSX.Element {
  const droppedOut = scopeCount - matchCount
  return (
    <span>
      <b>
        Retry: {verb === 'DELETE' ? 'deletes' : 'updates'} {documents(matchCount)}
      </b>{' '}
      in <code>{container}</code>
      {production && <b> (production)</b>}
      {droppedOut > 0 && (
        <>
          {' · '}
          {count(droppedOut)} of the {count(scopeCount)} no longer match or{' '}
          {droppedOut === 1 ? 'was' : 'were'} deleted, so {droppedOut === 1 ? 'it’s' : 'they’re'}{' '}
          left alone
        </>
      )}
    </span>
  )
}

/** The prod type-to-confirm field. Enter in it never confirms (story 92):
 * confirming takes a click, or Tab to the button and Enter. */
function TypeToConfirm({
  expected,
  value,
  matched,
  onChange
}: {
  expected: string
  value: string
  matched: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="dml-gate">
      <span>
        Type <code>{expected}</code> to confirm
      </span>
      <input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={value}
        placeholder={expected}
        aria-label={`Type ${expected} to confirm`}
        data-ok={matched ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
      />
    </label>
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
 * Above the results: planning progress with Cancel (story 76), the sample
 * while confirming (stories 85 to 88), the run report while committing
 * and after (stories 97 to 100, 104, 109, 110), and the end notices for
 * zero matches (story 79) and a discarded plan (story 94). Outcome rows
 * themselves stream into the ordinary results grid below, with raw codes.
 */
export function DmlRunReport({
  dml,
  onCancel,
  onOpenMatchesQuery,
  onRetry
}: {
  dml: DmlRunState | undefined
  onCancel: () => void
  onOpenMatchesQuery: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  if (!dml) return null
  switch (dml.phase) {
    case 'planning':
      if (dml.retry) {
        return (
          <div className="dml-notice" role="status">
            <span className="dml-spinner" aria-hidden="true" /> Re-checking{' '}
            {documents(dml.retry.scopeCount)}… {ru(dml.requestCharge)} RU
            <span className="dml-spacer" />
            <button type="button" className="btn--ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )
      }
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
    case 'confirming':
      return <DmlSample dml={dml} onOpenMatchesQuery={onOpenMatchesQuery} />
    case 'zero-matches':
      return (
        <div className="dml-notice" role="status">
          {dml.retry
            ? `None of the ${count(dml.retry.scopeCount)} still match. Nothing to write.`
            : 'No documents match. Nothing to write.'}
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
      return <CommitReport dml={dml} onStop={onCancel} onRetry={onRetry} />
    default:
      return null
  }
}

function CommitReport({
  dml,
  onStop,
  onRetry
}: {
  dml: Extract<DmlRunState, { phase: 'committing' | 'done' | 'stopped' }>
  onStop: () => void
  onRetry: () => void
}): React.JSX.Element {
  const past = dml.verb === 'DELETE' ? 'deleted' : 'updated'
  const ing = dml.verb === 'DELETE' ? 'Deleting' : 'Updating'
  let head: string
  let total: number
  let requestCharge: number
  let counts: Record<WriteOutcome, number>
  let projected: number | undefined
  if (dml.phase === 'committing') {
    const { progress } = dml
    total = progress.total
    counts = progress.counts
    requestCharge = dml.drivingQueryRequestCharge + progress.requestCharge
    projected = projectedRequestCharge(dml)
    head = `${dml.stopRequested ? 'Stopping after in-flight writes' : ing}… ${count(progress.completed)} of ${count(total)}`
  } else {
    const { summary } = dml
    counts = summary.counts
    total = dml.matchCount
    requestCharge = summary.drivingQueryRequestCharge + summary.writeRequestCharge
    const ending = dml.retry
      ? `Retry of the previous run${dml.phase === 'stopped' ? ', stopped' : ''}`
      : dml.phase === 'stopped'
        ? 'Stopped'
        : 'Done'
    head = `${ending}: ${past} ${count(summary.counts.written)} of ${count(total)}`
  }
  const scope = retryScope(dml)
  const duration = dml.phase === 'committing' ? undefined : dml.summary.durationMs
  const completed = dml.phase === 'committing' ? dml.progress.completed : total
  return (
    <div className="dml-report" role="status">
      <div className="dml-report__head">
        <b>{head}</b>
        <span className="dml-muted">
          {ruCompact(requestCharge)} RU
          {projected !== undefined && ` of ≈ ${ruCompact(projected)} projected`}
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
        className="dml-stack"
        role="progressbar"
        aria-label="Progress by Write Outcome"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
      >
        {outcomeBarSegments(counts, total).map((segment) => (
          <span
            key={segment.key}
            data-tone={segment.tone}
            style={{ width: `${total > 0 ? (segment.count / total) * 100 : 0}%` }}
          />
        ))}
      </div>
      <OutcomeTiles verb={dml.verb} counts={counts} />
      {dml.phase !== 'committing' && (
        <div className="dml-report__after">
          <ReRunHint verb={dml.verb} counts={counts} />
          {scope !== undefined && (
            <button
              type="button"
              title="Re-checks just these documents against their current versions: WHERE and SET are evaluated again, and you confirm before anything is written."
              onClick={onRetry}
            >
              Retry {count(scope)} not written
            </button>
          )}
        </div>
      )}
      {dml.phase !== 'committing' && dml.retryError && (
        <p className="dml-retry-error" role="alert">
          The Retry could not be planned: {dml.retryError}
        </p>
      )}
    </div>
  )
}

/** One tile per non-zero Write Outcome: count, label and one-line meaning
 * (story 104). The grid below keeps the raw codes. */
function OutcomeTiles({
  verb,
  counts
}: {
  verb: DmlVerb
  counts: Record<WriteOutcome, number>
}): React.JSX.Element | null {
  const shown = WRITE_OUTCOMES.filter((o) => counts[o] > 0)
  if (shown.length === 0) return null
  return (
    <div className="dml-tiles">
      {shown.map((outcome) => {
        const meaning = writeOutcomeMeaning(outcome)
        return (
          <div key={outcome} className="dml-tile" data-tone={writeOutcomeTone(outcome)}>
            <b>{count(counts[outcome])}</b>
            <span>{writeOutcomeLabel(outcome, verb)}</span>
            {meaning && <small>{meaning}</small>}
          </div>
        )
      })}
    </div>
  )
}

/** After a run that left documents unwritten, why running the statement
 * again is not the same as finishing this run (story 110). */
function ReRunHint({
  verb,
  counts
}: {
  verb: DmlVerb
  counts: Record<WriteOutcome, number>
}): React.JSX.Element | null {
  const n = notWrittenCount(counts)
  if (n === 0) return null
  return (
    <p className="dml-rerun">
      {documents(n)} {n === 1 ? 'was' : 'were'} not written. Running the statement again
      re-evaluates <code>WHERE</code> against current data and writes whatever still matches
      {verb === 'UPDATE' && (
        <>
          ; a <code>SET</code> that depends on the old value (<code>c.n = c.n + 1</code>) applies
          again to documents already updated
        </>
      )}
      .
    </p>
  )
}

/** Longest rendering of one sampled value before it is cut short. */
const SAMPLE_VALUE_CHARS = 60

function sampleValue(value: DmlSampleValue): string {
  if (!value.defined) return '(absent)'
  const text = JSON.stringify(value.value) ?? String(value.value)
  return text.length > SAMPLE_VALUE_CHARS ? `${text.slice(0, SAMPLE_VALUE_CHARS - 1)}…` : text
}

/** One partition key level of a sampled address; `{}` is the None value. */
function partitionKeyLevel(level: unknown): string {
  return level !== null && typeof level === 'object' ? '(none)' : JSON.stringify(level)
}

/**
 * While confirming, the first matches of the held DML Plan (stories 85 to
 * 87): the address of each (`id` and one column per partition key level),
 * and for `UPDATE` current → new for each `SET` path. Nothing is written
 * yet. "Preview as query ↗" opens the matches in full in a new tab while
 * this plan stays held (stories 88, 89).
 */
function DmlSample({
  dml,
  onOpenMatchesQuery
}: {
  dml: Extract<DmlRunState, { phase: 'confirming' }>
  onOpenMatchesQuery: () => void
}): React.JSX.Element | null {
  const { sample, partitionKeyPaths } = dml
  if (sample.length === 0) return null
  const targets = sample[0].changes?.map((change) => change.target) ?? []
  const levels = (document: DmlSampleDocument): unknown[] =>
    partitionKeyPaths.length === 1 ? [document.partitionKey] : (document.partitionKey as unknown[])
  return (
    <div className="dml-sample" role="region" aria-label="Sample of matching documents">
      <div className="dml-sample__head">
        <b className="dml-sample__title">Will {dml.verb === 'DELETE' ? 'delete' : 'update'}</b>
        <span className="dml-muted">
          first {count(sample.length)} of {count(dml.matchCount)} matches · nothing written yet
        </span>
        <span className="dml-spacer" />
        {/* A Retry's scope is a list of addresses, which a SELECT over the
            statement's WHERE can't show. */}
        {!dml.retry && (
          <button
            type="button"
            className="btn--ghost dml-link"
            title="Opens a new tab with SELECT * over the same WHERE (normal Row Limit applies). This plan stays held here."
            onClick={onOpenMatchesQuery}
          >
            Preview as query ↗
          </button>
        )}
      </div>
      <div className="dml-sample__scroll">
        <table className="dml-sample__table">
          <thead>
            <tr>
              <th>id</th>
              {partitionKeyPaths.map((path) => (
                <th key={path}>{path.replace(/^\//, '')}</th>
              ))}
              {targets.map((target) => (
                <th key={target}>{target}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((document) => (
              <tr key={`${document.id}\u0000${JSON.stringify(document.partitionKey)}`}>
                <td>{document.id}</td>
                {levels(document).map((level, i) => (
                  <td key={partitionKeyPaths[i]}>{partitionKeyLevel(level)}</td>
                ))}
                {document.changes?.map((change) => (
                  <td key={change.target}>
                    <span className="dml-muted">{sampleValue(change.current)}</span> →{' '}
                    <b>{sampleValue(change.next)}</b>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dml.matchCount > sample.length && (
        <p className="dml-muted dml-sample__more">…and {count(dml.matchCount - sample.length)} more.</p>
      )}
    </div>
  )
}
