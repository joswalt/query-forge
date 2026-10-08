import { useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import { QueryEditor, type QueryEditorHandle } from '../editor/QueryEditor'
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
  run: QueryRunState
}

/** Transient, non-rendered bookkeeping for one tab's in-flight execution —
 * kept out of React state since neither field should trigger a re-render by
 * itself (`cancel` is a stable callback; `cancelRequested` is read once,
 * when the matching `onError` arrives). */
interface ExecutionHandle {
  cancel: () => void
  cancelRequested: boolean
}

function createTab(index: number): QueryTabState {
  return {
    id: crypto.randomUUID(),
    title: `Query ${index}`,
    connectionId: undefined,
    queryText: '',
    run: initialQueryRunState
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
    dispatchRun(tabId, { type: 'started', startedAt })

    void window.api.queryStream
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
      .then((handle) => {
        executionsRef.current.set(tabId, { cancel: handle.cancel, cancelRequested: false })
      })
  }

  function handleCancel(tabId: string): void {
    const execution = executionsRef.current.get(tabId)
    if (!execution) return
    execution.cancelRequested = true
    execution.cancel()
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

          <QueryResultsView run={activeTab.run} />
        </div>
      )}
    </section>
  )
}
