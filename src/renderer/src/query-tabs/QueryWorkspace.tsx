import { useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type { ExportFormat } from '@shared/types/export'
import type { SavedQuery } from '@shared/types/saved-query'
import { QueryEditor, type QueryEditorHandle } from '../editor/QueryEditor'
import { initialExportState, type ExportState } from '../results/export-state'
import { SavedQueriesPanel } from '../saved-queries/SavedQueriesPanel'
import { QueryResultsView } from './QueryResultsView'
import {
  initialQueryRunState,
  queryRunReducer,
  type QueryRunAction,
  type QueryRunState
} from './query-run-reducer'

interface QueryTabState {
  id: string
  title: string
  connectionId: string | undefined
  queryText: string
  /** The exact text last sent to `queryStream.execute` — distinct from
   * `queryText` (the editor's *current* contents, which may have since
   * changed). "Export all matching rows" re-runs this, not whatever is
   * currently in the editor, so the export always matches what's on
   * screen. */
  lastExecutedQuery: string | undefined
  run: QueryRunState
  exportState: ExportState
}

/** Transient, non-rendered bookkeeping for one tab's in-flight execution —
 * kept out of React state since neither field should trigger a re-render by
 * itself (`cancel` is a stable callback; `cancelRequested` is read once,
 * when the matching `onError` arrives). */
interface ExecutionHandle {
  cancel: () => void
  cancelRequested: boolean
}

function createTab(
  index: number,
  seed?: { queryText: string; connectionId: string | undefined }
): QueryTabState {
  return {
    id: crypto.randomUUID(),
    title: `Query ${index}`,
    connectionId: seed?.connectionId,
    queryText: seed?.queryText ?? '',
    lastExecutedQuery: undefined,
    run: initialQueryRunState,
    exportState: initialExportState
  }
}

/**
 * Multiple independent query editor tabs (user stories 21-22, 29): each
 * tab owns its own connection selection, query text, and execution state,
 * so a slow/stuck query in one tab never blocks another. Results display is
 * intentionally minimal here — see QueryResultsView's doc comment.
 */
export function QueryWorkspace({
  connections
}: {
  connections: ConnectionProfile[]
}): React.JSX.Element {
  const [tabs, setTabs] = useState<QueryTabState[]>(() => [createTab(1)])
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id)
  const nextIndexRef = useRef(2)
  const executionsRef = useRef(new Map<string, ExecutionHandle>())
  const exportExecutionsRef = useRef(new Map<string, ExecutionHandle>())
  const editorRef = useRef<QueryEditorHandle>(null)

  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  function updateTab(id: string, updater: (tab: QueryTabState) => QueryTabState): void {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? updater(tab) : tab)))
  }

  /** Small, repeated shape (one of five call sites previously): run the tab's
   * execution reducer and write the result back. */
  function dispatchRun(tabId: string, action: QueryRunAction): void {
    updateTab(tabId, (t) => ({ ...t, run: queryRunReducer(t.run, action) }))
  }

  function handleNewTab(): void {
    const tab = createTab(nextIndexRef.current++)
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  function handleCloseTab(id: string): void {
    // Closing a tab mid-run must not silently abandon a live, RU-consuming
    // query — cancel it first, same as the Cancel button would.
    const execution = executionsRef.current.get(id)
    if (execution) {
      execution.cancelRequested = true
      execution.cancel()
    }
    executionsRef.current.delete(id)

    // Computed from the current render's `tabs`/`activeTabId` directly
    // (not via a `setTabs` functional updater) — this handler runs once per
    // click, so it doesn't have the updater-may-run-twice hazard a
    // functional updater has under StrictMode, and both the new tabs array
    // and the active-tab fallback need to agree on the *same* replacement
    // tab if the last one was just closed.
    const remaining = tabs.filter((tab) => tab.id !== id)
    const nextTabs = remaining.length > 0 ? remaining : [createTab(nextIndexRef.current++)]
    setTabs(nextTabs)
    if (activeTabId === id) {
      setActiveTabId(nextTabs[0].id)
    }
  }

  function handleExecute(tabId: string, queryText: string): void {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    if (!tab.connectionId) {
      dispatchRun(tabId, {
        type: 'failed',
        message: 'Select a connection before running a query.',
        finishedAt: Date.now(),
        cancelled: false
      })
      return
    }

    const startedAt = Date.now()
    updateTab(tabId, (t) => ({ ...t, lastExecutedQuery: queryText }))
    dispatchRun(tabId, { type: 'started', startedAt })

    // Placeholder registered *before* the `query:start` round-trip below
    // resolves — without it, a Cancel click during that (brief, but real)
    // window would find no entry in `executionsRef` and silently do
    // nothing. `cancel` is swapped for the real one once `execute` resolves
    // below; a cancel requested in the meantime is honored immediately then.
    const handle: ExecutionHandle = { cancel: () => {}, cancelRequested: false }
    executionsRef.current.set(tabId, handle)

    window.api.queryStream
      .execute(tab.connectionId, queryText, undefined, {
        onChunk: (chunk) => dispatchRun(tabId, { type: 'chunk', chunk }),
        onDone: () => {
          executionsRef.current.delete(tabId)
          dispatchRun(tabId, { type: 'done', finishedAt: Date.now() })
        },
        onError: (message) => {
          const cancelled = executionsRef.current.get(tabId)?.cancelRequested ?? false
          executionsRef.current.delete(tabId)
          dispatchRun(tabId, { type: 'failed', message, finishedAt: Date.now(), cancelled })
        }
      })
      .then((resolved) => {
        // Already torn down by a fast `onDone`/`onError` — nothing left to
        // attach the real `cancel` to.
        if (!executionsRef.current.has(tabId)) return
        handle.cancel = resolved.cancel
        if (handle.cancelRequested) resolved.cancel()
      })
      .catch((err) => {
        // `query:start`/`query:execute` setup itself failed (e.g. the
        // utilityProcess round-trip rejected) — without this, the tab
        // would stay stuck at `status: 'running'` forever, since neither
        // `onDone` nor `onError` above would ever fire.
        executionsRef.current.delete(tabId)
        dispatchRun(tabId, {
          type: 'failed',
          message: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
          cancelled: false
        })
      })
  }

  function handleCancel(tabId: string): void {
    const execution = executionsRef.current.get(tabId)
    if (!execution) return
    execution.cancelRequested = true
    execution.cancel()
  }

  function dispatchExport(tabId: string, exportState: ExportState): void {
    updateTab(tabId, (t) => ({ ...t, exportState }))
  }

  /** "Export loaded rows" (user story 45): the rows already in `tab.run`,
   * capped at MAX_DISPLAY_ROWS — a single bounded `invoke`, no progress
   * events or cancel (see export-ipc.ts's doc for why). */
  async function handleExportLoaded(tabId: string, format: ExportFormat): Promise<void> {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    const destinationPath = await window.api.export.chooseDestination(`export.${format}`)
    if (!destinationPath) return

    dispatchExport(tabId, { status: 'running', kind: 'loaded' })
    try {
      await window.api.export.exportLoaded(tab.run.rows, format, destinationPath)
      dispatchExport(tabId, { status: 'done' })
    } catch (err) {
      dispatchExport(tabId, {
        status: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** "Export all matching rows" (user story 46): re-executes
   * `tab.lastExecutedQuery` against `tab.connectionId` under a new
   * Execution ID (export-service.ts's doc: a second RU charge for
   * Cosmos — this is why it's a visibly distinct action from "export
   * loaded", not a toggle on the same button, per user story 47), with
   * progress and cancel (user story 48). */
  function handleExportAll(tabId: string, format: ExportFormat): void {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    if (!tab.connectionId || !tab.lastExecutedQuery) {
      dispatchExport(tabId, {
        status: 'error',
        message: 'Run a query in this tab before exporting all matching rows.'
      })
      return
    }
    const connectionId = tab.connectionId
    const query = tab.lastExecutedQuery

    window.api.export
      .chooseDestination(`export.${format}`)
      .then((destinationPath) => {
        if (!destinationPath) return

        dispatchExport(tabId, { status: 'running', kind: 'all', rowsWritten: undefined })

        // Same placeholder-then-swap pattern as handleExecute's `handle`:
        // a Cancel click during the `export:start` round-trip must still
        // find an entry to cancel.
        const handle: ExecutionHandle = { cancel: () => {}, cancelRequested: false }
        exportExecutionsRef.current.set(tabId, handle)

        window.api.export
          .exportAll(connectionId, query, undefined, format, destinationPath, {
            onProgress: (rowsWritten) =>
              dispatchExport(tabId, { status: 'running', kind: 'all', rowsWritten }),
            onDone: () => {
              exportExecutionsRef.current.delete(tabId)
              dispatchExport(tabId, { status: 'done' })
            },
            onError: (message) => {
              const cancelled = exportExecutionsRef.current.get(tabId)?.cancelRequested ?? false
              exportExecutionsRef.current.delete(tabId)
              dispatchExport(tabId, cancelled ? { status: 'cancelled' } : { status: 'error', message })
            }
          })
          .then((resolved) => {
            if (!exportExecutionsRef.current.has(tabId)) return
            handle.cancel = resolved.cancel
            if (handle.cancelRequested) resolved.cancel()
          })
          .catch((err) => {
            exportExecutionsRef.current.delete(tabId)
            dispatchExport(tabId, {
              status: 'error',
              message: err instanceof Error ? err.message : String(err)
            })
          })
      })
      .catch((err) => {
        dispatchExport(tabId, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      })
  }

  function handleCancelExport(tabId: string): void {
    const execution = exportExecutionsRef.current.get(tabId)
    if (!execution) return
    execution.cancelRequested = true
    execution.cancel()
  }

  /** "Open in new tab" (user story 51's companion to saving) — a saved
   * query's connection association is only honored if that profile still
   * exists; a deleted Connection Profile (user story 5) must not leave the
   * new tab pointing at a dangling id. */
  function handleOpenSavedQuery(savedQuery: SavedQuery): void {
    const connectionId = connections.some((c) => c.id === savedQuery.profileId)
      ? savedQuery.profileId
      : undefined
    const tab = createTab(nextIndexRef.current++, {
      queryText: savedQuery.queryText,
      connectionId
    })
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  /** "Save current query" — the active tab's full query text (not
   * `editorRef.getExecutionText()`, which returns only the selection when
   * one exists; saving a query should never silently save a sub-selection
   * instead of the whole thing the user is looking at). */
  async function handleSaveCurrentQuery(name: string): Promise<void> {
    if (!activeTab) return
    const databaseKind = connections.find((c) => c.id === activeTab.connectionId)?.config.kind
    await window.api.savedQueries.create({
      name,
      queryText: activeTab.queryText,
      profileId: activeTab.connectionId,
      databaseKind
    })
  }

  return (
    <section className="query-workspace">
      <h2>Queries</h2>
      <div className="query-workspace__tabbar" role="tablist">
        {tabs.map((tab) => (
          <span key={tab.id} className={tab.id === activeTabId ? 'is-active' : ''}>
            <button type="button" role="tab" onClick={() => setActiveTabId(tab.id)}>
              {tab.title}
              {tab.run.status === 'running' ? ' …' : ''}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => handleCloseTab(tab.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button type="button" onClick={handleNewTab}>
          + New tab
        </button>
      </div>

      {activeTab && (
        <div className="query-workspace__tab">
          <label>
            Connection
            <select
              value={activeTab.connectionId ?? ''}
              onChange={(e) =>
                updateTab(activeTab.id, (t) => ({ ...t, connectionId: e.target.value || undefined }))
              }
            >
              <option value="">— select a connection —</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          </label>

          <div className="query-workspace__actions">
            <button
              type="button"
              disabled={activeTab.run.status === 'running'}
              onClick={() =>
                handleExecute(
                  activeTab.id,
                  editorRef.current?.getExecutionText() ?? activeTab.queryText
                )
              }
            >
              Run (⌘/Ctrl+Enter)
            </button>
            <button
              type="button"
              disabled={activeTab.run.status !== 'running'}
              onClick={() => handleCancel(activeTab.id)}
            >
              Cancel
            </button>
          </div>

          <QueryEditor
            key={activeTab.id}
            ref={editorRef}
            initialValue={activeTab.queryText}
            dialect={connections.find((c) => c.id === activeTab.connectionId)?.config.kind}
            onChange={(text) => updateTab(activeTab.id, (t) => ({ ...t, queryText: text }))}
            onExecute={(text) => handleExecute(activeTab.id, text)}
          />

          <QueryResultsView
            run={activeTab.run}
            exportState={activeTab.exportState}
            onExportLoaded={(format) => void handleExportLoaded(activeTab.id, format)}
            onExportAll={(format) => handleExportAll(activeTab.id, format)}
            onCancelExport={() => handleCancelExport(activeTab.id)}
          />
        </div>
      )}

      <SavedQueriesPanel
        canSaveCurrent={Boolean(activeTab?.queryText.trim())}
        onSaveCurrent={handleSaveCurrentQuery}
        onOpen={handleOpenSavedQuery}
      />
    </section>
  )
}
