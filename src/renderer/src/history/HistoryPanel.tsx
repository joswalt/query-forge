import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { DmlHistoryDetail, QueryHistoryEntry } from '@shared/types/query-history'
import { WRITE_OUTCOMES, writeOutcomeLabel } from '@shared/types/dml-run'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'
import { ConnectionTag } from '../library/ConnectionTag'
import { useCopiedFlag } from '../library/use-copied-flag'
import {
  formatDuration,
  formatRowCount,
  groupHistoryByDay,
  historyTimeLabel
} from './history-format'

/** Remembers that the "keep query text" question was answered, either way,
 * so it is asked once. The setting itself lives in Preferences. */
const OPT_IN_ANSWERED_KEY = 'queryforge.ui.historyOptInAnswered'
const SEARCH_DELAY_MS = 200

function readAnswered(): boolean {
  try {
    return localStorage.getItem(OPT_IN_ANSWERED_KEY) === '1'
  } catch {
    return false
  }
}

/** A DML entry's chip: `DELETE · carts`. */
function dmlChipText(dml: DmlHistoryDetail): string {
  return [dml.verb, dml.containerName].filter(Boolean).join(' · ')
}

/** Run report tile labels read mid-sentence: `Changed by someone else`
 * becomes `changed by someone else`; `SET was undefined` keeps its keyword. */
function inlineLabel(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label
}

/** An entry's stats: rows and duration for a query; for a DML entry,
 * documents matched, each non-zero Write Outcome by its run report label,
 * duration and total RU, e.g. `1,840 matched`, `1,837 deleted`,
 * `3 changed by someone else`, `2.4 s`, `412 RU`. */
function entryStats(entry: QueryHistoryEntry): string[] {
  const { dml, rowCount, durationMs } = entry
  if (!dml) {
    return [...(rowCount !== undefined ? [formatRowCount(rowCount)] : []), formatDuration(durationMs)]
  }
  const verb = dml.verb ?? 'DELETE'
  return [
    ...(rowCount !== undefined ? [`${rowCount.toLocaleString('en-US')} matched`] : []),
    ...WRITE_OUTCOMES.filter((o) => dml.counts[o] > 0).map(
      (o) => `${dml.counts[o].toLocaleString('en-US')} ${inlineLabel(writeOutcomeLabel(o, verb))}`
    ),
    formatDuration(durationMs),
    `${dml.totalRequestCharge.toLocaleString('en-US', { maximumFractionDigits: 2 })} RU`
  ]
}

const STATUS_LABEL: Record<QueryHistoryEntry['status'], string> = {
  success: 'succeeded',
  partial: 'partial',
  error: 'error',
  cancelled: 'cancelled'
}

/** A query entry with text can be reopened; a DML Statement entry can only
 * be copied, so reopening it is never one click away from a second run. */
export function canReopen(entry: QueryHistoryEntry): boolean {
  return entry.queryText !== undefined && !entry.dml
}

interface Props {
  connections: ConnectionProfile[]
  onOpen: (entry: QueryHistoryEntry) => void
}

/**
 * Query History (user stories 50, 52, 53): every run, refreshed whenever one
 * settles (`history:updated`). Query text shows for this session even with
 * the opt-in off, as Session Query Text held in main's memory; the opt-in
 * ("Keep query text after quitting", asked once, then in the ⋯ menu) is
 * what writes it to disk. "Clear history" removes both.
 *
 * Clicking a query entry opens it in a new tab on the same connection and
 * container. A DML Statement entry shows its verb, container and Write
 * Outcome counts, readable with the text withheld, and can be copied but
 * not reopened.
 */
export function HistoryPanel({ connections, onOpen }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<QueryHistoryEntry[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [persistQueryText, setPersistQueryText] = useState<boolean | null>(null)
  const [optInAnswered, setOptInAnswered] = useState(readAnswered)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, markCopied] = useCopiedFlag()

  // Read by the `history:updated` subscription, which must act on the
  // *current* search without re-subscribing on every keystroke.
  const searchTermRef = useRef(searchTerm)
  searchTermRef.current = searchTerm

  async function refresh(term: string): Promise<void> {
    try {
      const results = term.trim()
        ? await window.api.history.search(term.trim())
        : await window.api.history.list()
      // A slower, older search must not overwrite a newer one's results.
      if (term === searchTermRef.current) setEntries(results)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    window.api.preferences
      .get()
      .then((prefs) => setPersistQueryText(prefs.queryHistory.persistQueryText))
      .catch(() => setPersistQueryText(false))
    const stopPrefs = window.api.preferences.onUpdated((prefs) =>
      setPersistQueryText(prefs.queryHistory.persistQueryText)
    )
    const stopHistory = window.api.history.onUpdated(() => void refresh(searchTermRef.current))
    return () => {
      stopPrefs()
      stopHistory()
    }
  }, [])

  // Live search: the list follows what's typed, after a short pause.
  useEffect(() => {
    const handle = setTimeout(() => void refresh(searchTerm), searchTerm ? SEARCH_DELAY_MS : 0)
    return () => clearTimeout(handle)
  }, [searchTerm])

  function answerOptIn(): void {
    setOptInAnswered(true)
    try {
      localStorage.setItem(OPT_IN_ANSWERED_KEY, '1')
    } catch {
      // Best-effort: worst case the question is asked again next launch.
    }
  }

  async function setKeepQueryText(checked: boolean): Promise<void> {
    answerOptIn()
    const previous = persistQueryText
    setPersistQueryText(checked)
    try {
      await window.api.preferences.update({ queryHistory: { persistQueryText: checked } })
    } catch (err) {
      // Revert, so the menu never shows "kept" while the stored preference
      // silently stayed off (or the reverse), user story 53's concern.
      setPersistQueryText(previous)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleClearHistory(): Promise<void> {
    if (!window.confirm('Delete all query history? This cannot be undone.')) return
    try {
      await window.api.history.clear()
      await refresh(searchTermRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCopy(entry: QueryHistoryEntry): Promise<void> {
    if (!entry.queryText) return
    try {
      await navigator.clipboard.writeText(entry.queryText)
      markCopied(entry.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const term = searchTerm.trim()
  const showOptIn = persistQueryText === false && !optInAnswered && entries.length > 0 && !term

  function renderEntry(entry: QueryHistoryEntry): React.JSX.Element {
    const connection = connections.find((c) => c.id === entry.profileId)
    const reopenable = canReopen(entry)
    const actions: OverflowMenuItem[] = [
      ...(reopenable ? [{ label: 'Open in new tab', onSelect: () => onOpen(entry) }] : []),
      ...(entry.queryText ? [{ label: 'Copy query', onSelect: () => void handleCopy(entry) }] : [])
    ]
    const content = (
      <>
        <span className="lib-row__head">
          <ConnectionTag
            connection={connection}
            fallbackName={entry.profileName}
            kind={entry.dml ? 'cosmos-db' : undefined}
          />
          <time
            className="lib-row__time"
            dateTime={entry.executedAt}
            title={new Date(entry.executedAt).toLocaleString()}
          >
            {copiedId === entry.id ? 'Copied' : historyTimeLabel(entry.executedAt)}
          </time>
        </span>
        {entry.queryText !== undefined ? (
          <code
            className="lib-row__query"
            title={entry.queryTextSessionOnly ? 'Kept until you quit QueryForge' : undefined}
          >
            {entry.queryText}
          </code>
        ) : (
          <span
            className="lib-row__withheld"
            title={
              persistQueryText
                ? 'Run before query text was kept after quitting'
                : 'Turn on “Keep query text after quitting” in the history options (⋯) to keep it for future runs'
            }
          >
            Query text not saved
          </span>
        )}
        <span className="lib-row__stats">
          {/* Success is the quiet default; anything else is named. */}
          {entry.status !== 'success' && (
            <span className="status-pill" data-status={entry.status}>
              {STATUS_LABEL[entry.status]}
            </span>
          )}
          {entry.dml && <span className="chip lib-row__dml">{dmlChipText(entry.dml)}</span>}
          {entry.dml?.retry && (
            <span
              className="chip"
              title="A Retry of an earlier run: only the documents that run left not written"
            >
              retry
            </span>
          )}
          {entry.target?.container && !entry.dml && (
            <span className="lib-row__target">{entry.target.container}</span>
          )}
          {entryStats(entry).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
        {entry.errorMessage && <span className="lib-row__error">{entry.errorMessage}</span>}
      </>
    )
    return (
      <li
        key={entry.id}
        className="lib-row"
        data-env={connection?.environment}
        data-status={entry.status}
      >
        {reopenable ? (
          <button
            type="button"
            className="lib-row__body lib-row__open"
            title="Open in new tab"
            onClick={() => onOpen(entry)}
          >
            {content}
          </button>
        ) : (
          <div className="lib-row__body">{content}</div>
        )}
        {actions.length > 0 && (
          <OverflowMenu label={`More actions for this ${entry.profileName} run`} items={actions} />
        )}
      </li>
    )
  }

  return (
    <div className="library-panel">
      <div className="library-toolbar">
        <input
          type="search"
          placeholder="Search history"
          aria-label="Search history by connection, query text or container"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <OverflowMenu
          label="History options"
          items={[
            {
              label: 'Keep query text after quitting',
              checked: persistQueryText === true,
              disabled: persistQueryText === null,
              onSelect: () => void setKeepQueryText(!persistQueryText)
            },
            { label: 'Clear history', danger: true, onSelect: () => void handleClearHistory() }
          ]}
        />
      </div>

      {error && <p role="alert">{error}</p>}
      <p className="visually-hidden" role="status">
        {copiedId ? 'Query copied' : ''}
      </p>

      {showOptIn && (
        <div className="history-opt-in">
          <p>
            Query text is kept only until you quit. Keep it after quitting so you can search and
            reopen past queries later? Unsaved tabs are then restored after a crash, too. It all
            stays on this computer.
          </p>
          <div className="history-opt-in__actions">
            <button type="button" className="btn--primary" onClick={() => void setKeepQueryText(true)}>
              Keep query text
            </button>
            <button type="button" className="btn--ghost" onClick={answerOptIn}>
              Not now
            </button>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="empty">
          {term
            ? `Nothing in history matches “${term}”.`
            : 'Queries you run appear here. Click one to open it in a new tab.'}
        </p>
      ) : (
        groupHistoryByDay(entries).map((day) => (
          <section key={day.label} className="lib-day" aria-label={day.label}>
            <h3 className="lib-day__label">{day.label}</h3>
            <ul className="lib-list">{day.entries.map(renderEntry)}</ul>
          </section>
        ))
      )}
    </div>
  )
}
