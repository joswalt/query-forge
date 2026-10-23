import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ConnectionProfile } from '@shared/types/connection-profile'
import type {
  DatabaseMetadataObject,
  QueryOptions
} from '@shared/types/database-provider'
import { getExtractor, type ExtractorId, type ExtractorOptions } from '@shared/extractors/extract'
import { QueryEditor, type QueryEditorHandle } from '../editor/QueryEditor'
import { initialExportState, type ExportState } from '../results/export-state'
import { useExtractorSettings } from '../results/extractor-settings'
import { CloseIcon, PlayIcon, PlusIcon } from '../icons'
import { QueryResultsView, type ExportLoadedRequest } from './QueryResultsView'
import { EditorResizer, useEditorHeight } from './EditorResizer'
import {
  initialQueryRunState,
  MAX_DISPLAY_ROWS,
  queryRunReducer,
  type QueryRunAction,
  type QueryRunState
} from './query-run-reducer'

interface QueryTabState {
  id: string
  title: string
  connectionId: string | undefined
  queryText: string
  /** Per-tab execution context, e.g. the Cosmos DB database/container opened
   * from the Object Explorer. */
  options: QueryOptions | undefined
  /** The exact text last sent to `queryStream.execute` — distinct from
   * `queryText` (the editor's *current* contents, which may have since
   * changed). "Export all matching rows" re-runs this, not whatever is
   * currently in the editor, so the export always matches what's on
   * screen. */
  lastExecutedQuery: string | undefined
  /** Cosmos DB Row Limit (GLOSSARY.md): how many rows to fetch before the
   * Provider stops paging, or `'all'` to run to completion. Deliberately not
   * persisted in drafts — every session starts back on the RU-safe default. */
  rowLimit: RowLimit
  /** The SQL Extractors' Table field once the user has typed in it;
   * `undefined` while it still follows the inferred name. */
  tableNameOverride: string | undefined
  run: QueryRunState
  exportState: ExportState
}

/** The Table field's value when no name can be inferred (user story 39). */
const FALLBACK_TABLE_NAME = 'my_table'

/** The table name inferred for a tab, if any: the Cosmos container the tab
 * targets. */
function inferredTableName(tab: QueryTabState): string | undefined {
  return tab.options?.container
}

function tableNameFor(tab: QueryTabState): string {
  return tab.tableNameOverride ?? inferredTableName(tab) ?? FALLBACK_TABLE_NAME
}

/** `yyyyMMdd-HHmm` in local time. */
function fileTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  )
}

/** Transient, non-rendered bookkeeping for one tab's in-flight execution —
 * kept out of React state since neither field should trigger a re-render by
 * itself (`cancel` is a stable callback; `cancelRequested` is read once,
 * when the matching `onError` arrives). */
interface ExecutionHandle {
  cancel: () => void
  cancelRequested: boolean
}

export interface OpenQuerySeed {
  queryText: string
  connectionId: string | undefined
  title?: string
  options?: QueryOptions
}

export interface QueryWorkspaceHandle {
  /** Opens a new tab prefilled with `seed` (Object Explorer double-click, user story 17). */
  openQuery: (seed: OpenQuerySeed) => void
}

function createTab(index: number, seed?: OpenQuerySeed): QueryTabState {
  return {
    id: crypto.randomUUID(),
    title: seed?.title ?? `Query ${index}`,
    connectionId: seed?.connectionId,
    queryText: seed?.queryText ?? '',
    options: seed?.options,
    lastExecutedQuery: undefined,
    rowLimit: DEFAULT_ROW_LIMIT,
    tableNameOverride: undefined,
    run: initialQueryRunState,
    exportState: initialExportState
  }
}

type RowLimit = number | 'all'

/** Choices for the Cosmos Row Limit dropdown. The top numeric choice is the
 * renderer's display bound (`MAX_DISPLAY_ROWS`) — a limit above it would fetch
 * rows the grid then discards. `'all'` still only displays that many. */
const ROW_LIMIT_CHOICES: RowLimit[] = [100, 1_000, 10_000, MAX_DISPLAY_ROWS, 'all']
const DEFAULT_ROW_LIMIT: RowLimit = MAX_DISPLAY_ROWS

function rowLimitLabel(limit: RowLimit): string {
  return limit === 'all' ? 'All rows' : `${limit.toLocaleString()} rows`
}

/** Cosmos DB's `maxRows` for one Run; `'all'` leaves it unset. */
function toMaxRows(limit: RowLimit): number | undefined {
  return limit === 'all' ? undefined : limit
}

/** Cosmos containers a tab can target, loaded once per connection. */
type ContainerList =
  | { status: 'loading' }
  | { status: 'ready'; items: { database: string; container: string }[] }
  | { status: 'unavailable'; message: string }

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function collectContainers(
  objects: DatabaseMetadataObject[]
): { database: string; container: string }[] {
  const found: { database: string; container: string }[] = []
  for (const object of objects) {
    if (object.kind === 'container' && object.database) {
      found.push({ database: object.database, container: object.name })
    }
    found.push(...collectContainers(object.children ?? []))
  }
  return found.sort(
    (a, b) =>
      nameCollator.compare(a.database, b.database) || nameCollator.compare(a.container, b.container)
  )
}

const PICKER_SEPARATOR = '\u0001'

const RUN_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter'

const DRAFTS_KEY = 'queryforge.drafts.v1'
const DRAFT_SAVE_DEBOUNCE_MS = 500

interface DraftTab {
  title: string
  connectionId: string | undefined
  queryText: string
  options: QueryOptions | undefined
}

/** Unsaved tab contents survive a crash or unexpected shutdown (user story
 * 55). Stored in the renderer's own localStorage (Electron userData) rather
 * than SQLite — a draft is transient scratch state, not a Saved Query. */
function loadDrafts(): { tabs: DraftTab[]; activeIndex: number } | undefined {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { tabs?: DraftTab[]; activeIndex?: number }
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return undefined
    return { tabs: parsed.tabs, activeIndex: parsed.activeIndex ?? 0 }
  } catch {
    return undefined
  }
}

function initialTabs(): { tabs: QueryTabState[]; activeIndex: number } {
  const drafts = loadDrafts()
  if (!drafts) return { tabs: [createTab(1)], activeIndex: 0 }
  return {
    tabs: drafts.tabs.map((draft) => ({
      ...createTab(1, { ...draft }),
      title: draft.title
    })),
    activeIndex: Math.min(drafts.activeIndex, drafts.tabs.length - 1)
  }
}

/**
 * Multiple independent query editor tabs (user stories 21-22, 29): each
 * tab owns its own connection selection, query text, and execution state,
 * so a slow/stuck query in one tab never blocks another. Results display is
 * intentionally minimal here — see QueryResultsView's doc comment.
 */
export const QueryWorkspace = forwardRef<
  QueryWorkspaceHandle,
  {
    connections: ConnectionProfile[]
    /** Ids of connections with a live session; a container list that failed to
     * load while disconnected is retried once its connection comes up. */
    connectedIds?: readonly string[]
    /** Called after "Save query" succeeds so the sidebar list can reload. */
    onQuerySaved?: () => void
  }
>(function QueryWorkspace(
  { connections, connectedIds, onQuerySaved },
  handleRef
): React.JSX.Element {
  const [restored] = useState(initialTabs)
  const [tabs, setTabs] = useState<QueryTabState[]>(restored.tabs)
  const [activeTabId, setActiveTabId] = useState<string>(
    () => restored.tabs[restored.activeIndex].id
  )
  const [fileMessage, setFileMessage] = useState<string | null>(null)
  const [containerLists, setContainerLists] = useState<Record<string, ContainerList>>({})
  // Non-null while the "Save query…" name field is open.
  const [saveName, setSaveName] = useState<string | null>(null)
  // Drafts hold query text, so they honor the same opt-in as history text
  // (user story 53): off until the preference says otherwise.
  const [persistDrafts, setPersistDrafts] = useState(false)
  useEffect(() => {
    window.api.preferences
      .get()
      .then((prefs) => setPersistDrafts(prefs.queryHistory.persistQueryText))
      .catch(() => {})
  }, [])
  const nextIndexRef = useRef(restored.tabs.length + 1)
  const executionsRef = useRef(new Map<string, ExecutionHandle>())
  const exportExecutionsRef = useRef(new Map<string, ExecutionHandle>())
  const [extractorSettings, updateExtractorSettings] = useExtractorSettings()
  const editorRef = useRef<QueryEditorHandle>(null)
  const editorHeight = useEditorHeight()

  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  // The name field belongs to the tab it was opened on.
  useEffect(() => setSaveName(null), [activeTabId])

  useImperativeHandle(handleRef, () => ({
    openQuery: (seed) => {
      const tab = createTab(nextIndexRef.current++, seed)
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    }
  }))

  useEffect(() => {
    if (!persistDrafts) {
      try {
        localStorage.removeItem(DRAFTS_KEY)
      } catch {
        // ignore
      }
      return
    }
    const timer = setTimeout(() => {
      try {
        const drafts: DraftTab[] = tabs.map((t) => ({
          title: t.title,
          connectionId: t.connectionId,
          queryText: t.queryText,
          options: t.options
        }))
        localStorage.setItem(
          DRAFTS_KEY,
          JSON.stringify({ tabs: drafts, activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)) })
        )
      } catch {
        // Best-effort only — a full/disabled localStorage must never break editing.
      }
    }, DRAFT_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [tabs, activeTabId, persistDrafts])

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

    // `maxRows` goes on this call only — never into `tab.options`, which
    // "Export all matching rows" reuses and which must stay uncapped.
    const maxRows = toMaxRows(tab.rowLimit)
    const executeOptions: QueryOptions =
      maxRows === undefined ? { ...tab.options } : { ...tab.options, maxRows }

    window.api.queryStream
      .execute(tab.connectionId, queryText, executeOptions, {
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

  /** Suggested save-dialog name (user stories 16-17):
   * `<container-or-table>_<yyyyMMdd-HHmm>.<ext>`, falling back to the
   * profile name. Later Result Sets of a script are numbered so exporting
   * several in a row doesn't offer to overwrite the first. */
  function exportFileName(tab: QueryTabState, extractorId: ExtractorId, resultSet: number): string {
    const base =
      tab.tableNameOverride ??
      inferredTableName(tab) ??
      connections.find((c) => c.id === tab.connectionId)?.name ??
      'export'
    const safeBase = base.replace(/[\\/:*?"<>|\[\]]+/g, '_').replace(/^_+|_+$/g, '') || 'export'
    const setSuffix = resultSet > 0 ? `_result-${resultSet + 1}` : ''
    const extension = getExtractor(extractorId).fileExtension
    return `${safeBase}${setSuffix}_${fileTimestamp(new Date())}.${extension}`
  }

  function extractorOptionsFor(tab: QueryTabState): ExtractorOptions {
    return { includeHeader: extractorSettings.includeHeader, tableName: tableNameFor(tab) }
  }

  function dispatchExport(tabId: string, exportState: ExportState): void {
    updateTab(tabId, (t) => ({ ...t, exportState }))
  }

  /** "Export loaded rows" (user story 45): the rows already in `tab.run`,
   * capped at MAX_DISPLAY_ROWS — a single bounded `invoke`, no progress
   * events or cancel (see export-ipc.ts's doc for why). */
  async function handleExportLoaded(tabId: string, request: ExportLoadedRequest): Promise<void> {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const extractorId = request.extractorId ?? extractorSettings.extractorId

    const destinationPath = await window.api.export.chooseDestination(
      exportFileName(tab, extractorId, request.resultSet)
    )
    if (!destinationPath) return

    dispatchExport(tabId, { status: 'running', kind: 'loaded' })
    try {
      await window.api.export.exportLoaded(
        request.rows,
        request.columns,
        extractorId,
        extractorOptionsFor(tab),
        destinationPath
      )
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
  function handleExportAll(tabId: string, resultSet: number): void {
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
    const options = tab.options
    const extractorId = extractorSettings.extractorId
    const extractorOptions = extractorOptionsFor(tab)

    window.api.export
      .chooseDestination(exportFileName(tab, extractorId, resultSet))
      .then((destinationPath) => {
        if (!destinationPath) return

        dispatchExport(tabId, { status: 'running', kind: 'all', rowsWritten: undefined })

        // Same placeholder-then-swap pattern as handleExecute's `handle`:
        // a Cancel click during the `export:start` round-trip must still
        // find an entry to cancel.
        const handle: ExecutionHandle = { cancel: () => {}, cancelRequested: false }
        exportExecutionsRef.current.set(tabId, handle)

        window.api.export
          .exportAll(
            connectionId,
            query,
            options,
            extractorId,
            extractorOptions,
            resultSet,
            destinationPath,
            {
              onProgress: (rowsWritten) =>
                dispatchExport(tabId, { status: 'running', kind: 'all', rowsWritten }),
              onDone: () => {
                exportExecutionsRef.current.delete(tabId)
                dispatchExport(tabId, { status: 'done' })
              },
              onError: (message) => {
                const cancelled = exportExecutionsRef.current.get(tabId)?.cancelRequested ?? false
                exportExecutionsRef.current.delete(tabId)
                dispatchExport(
                  tabId,
                  cancelled ? { status: 'cancelled' } : { status: 'error', message }
                )
              }
            }
          )
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

  /** Save the active tab's text to a local file (user story 23). */
  function loadContainers(connectionId: string): void {
    setContainerLists((prev) => ({ ...prev, [connectionId]: { status: 'loading' } }))
    window.api.queryExecution
      .getMetadata(connectionId)
      .then((metadata) =>
        setContainerLists((prev) => ({
          ...prev,
          [connectionId]: { status: 'ready', items: collectContainers(metadata.objects) }
        }))
      )
      .catch(() =>
        setContainerLists((prev) => ({
          ...prev,
          [connectionId]: {
            status: 'unavailable',
            message: 'Connect to this connection to list its containers.'
          }
        }))
      )
  }

  // A Cosmos profile without a fixed container needs one picked per tab.
  const activeConnection = connections.find((c) => c.id === activeTab?.connectionId)
  const activeCosmos = activeConnection?.config.kind === 'cosmos-db' ? activeConnection.config : undefined
  const needsContainerPicker = Boolean(activeCosmos && !(activeCosmos.database && activeCosmos.container))
  const activeConnectionId = activeConnection?.id
  const hasContainerList = activeConnectionId ? activeConnectionId in containerLists : true

  const activeIsConnected = activeConnectionId ? (connectedIds?.includes(activeConnectionId) ?? false) : false
  const activeListUnavailable = activeConnectionId
    ? containerLists[activeConnectionId]?.status === 'unavailable'
    : false

  useEffect(() => {
    if (!activeConnectionId || !needsContainerPicker) return
    if (!hasContainerList || (activeIsConnected && activeListUnavailable)) {
      loadContainers(activeConnectionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, needsContainerPicker, hasContainerList, activeIsConnected, activeListUnavailable])

  async function handleSaveToFile(): Promise<void> {
    if (!activeTab) return
    try {
      const path = await window.api.files.saveQuery(`${activeTab.title}.sql`, activeTab.queryText)
      setFileMessage(path ? `Saved to ${path}` : null)
    } catch (err) {
      setFileMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Open a local query file in a new tab, inheriting the active tab's connection. */
  async function handleOpenFile(): Promise<void> {
    try {
      const file = await window.api.files.openQuery()
      if (!file) return
      const tab = createTab(nextIndexRef.current++, {
        title: file.name,
        queryText: file.content,
        connectionId: activeTab?.connectionId,
        options: activeTab?.options
      })
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
      setFileMessage(null)
    } catch (err) {
      setFileMessage(`Open failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** "Save query…" — the active tab's full query text (not
   * `editorRef.getExecutionText()`, which returns only the selection when
   * one exists; saving a query should never silently save a sub-selection
   * instead of the whole thing the user is looking at). */
  async function handleSaveQuery(): Promise<void> {
    if (!activeTab || saveName === null) return
    const name = saveName.trim()
    if (!name || !activeTab.queryText.trim()) return
    const databaseKind = connections.find((c) => c.id === activeTab.connectionId)?.config.kind
    try {
      await window.api.savedQueries.create({
        name,
        queryText: activeTab.queryText,
        profileId: activeTab.connectionId,
        databaseKind
      })
      setSaveName(null)
      setFileMessage(`Saved query “${name}”.`)
      onQuerySaved?.()
    } catch (err) {
      setFileMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <section className="query-workspace">
      <div className="query-workspace__tabbar" role="tablist" aria-label="Query tabs">
        {tabs.map((tab) => (
          <span
            key={tab.id}
            className={`query-tab${tab.id === activeTabId ? ' is-active' : ''}`}
            data-running={tab.run.status === 'running' ? 'true' : undefined}
          >
            <button
              type="button"
              role="tab"
              className="query-tab__title"
              aria-selected={tab.id === activeTabId}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.title}
              {tab.run.status === 'running' ? ' …' : ''}
            </button>
            <button
              type="button"
              className="query-tab__close"
              aria-label={`Close ${tab.title}`}
              onClick={() => handleCloseTab(tab.id)}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        ))}
        <button type="button" className="btn--ghost query-workspace__new" onClick={handleNewTab}>
          <PlusIcon size={13} /> New tab
        </button>
        <button type="button" className="btn--ghost" onClick={() => void handleOpenFile()}>
          Open file…
        </button>
      </div>
      {fileMessage && <p className="query-workspace__message">{fileMessage}</p>}

      {activeTab && (
        <div
          className="query-workspace__tab"
          style={{ '--qf-editor-height': `${editorHeight.height}px` } as React.CSSProperties}
        >
          <div className="query-workspace__toolbar">
            <div className="query-workspace__targets">
              <label className="query-workspace__connection">
                Connection
                <select
                  value={activeTab.connectionId ?? ''}
                  onChange={(e) =>
                    // A container belongs to one connection — never carry it over.
                    updateTab(activeTab.id, (t) => ({
                      ...t,
                      connectionId: e.target.value || undefined,
                      options: undefined
                    }))
                  }
                >
                  <option value="">Select a connection</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
              </label>

              {activeCosmos && needsContainerPicker && activeConnectionId && (
                <ContainerPicker
                  list={containerLists[activeConnectionId]}
                  fixedDatabase={activeCosmos.database}
                  value={activeTab.options}
                  onRetry={() => loadContainers(activeConnectionId)}
                  onChange={(options) => updateTab(activeTab.id, (t) => ({ ...t, options }))}
                />
              )}
            </div>

            <div className="query-workspace__actions">
              {activeCosmos && (
                <label
                  className="query-workspace__row-limit"
                  title="Stops the query once this many rows are returned, so a large container isn't paged to the end for request units. Rows are fetched 100 at a time, so a limit under 100 still reads one full page. “All rows” runs to completion (the grid still shows at most 50,000)."
                >
                  Row limit
                  <select
                    value={String(activeTab.rowLimit)}
                    onChange={(e) =>
                      updateTab(activeTab.id, (t) => ({
                        ...t,
                        rowLimit: e.target.value === 'all' ? 'all' : Number(e.target.value)
                      }))
                    }
                  >
                    {ROW_LIMIT_CHOICES.map((choice) => (
                      <option key={String(choice)} value={String(choice)}>
                        {rowLimitLabel(choice)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="btn--ghost"
                aria-expanded={saveName !== null}
                disabled={!activeTab.queryText.trim()}
                onClick={() => setSaveName((current) => (current === null ? activeTab.title : null))}
              >
                Save query…
              </button>
              <button type="button" className="btn--ghost" onClick={() => void handleSaveToFile()}>
                Save to file…
              </button>
              <button
                type="button"
                className="btn--ghost"
                disabled={!activeTab.queryText.trim()}
                onClick={() => editorRef.current?.format()}
              >
                Format
              </button>
              <button
                type="button"
                disabled={activeTab.run.status !== 'running'}
                onClick={() => handleCancel(activeTab.id)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn--run"
                disabled={activeTab.run.status === 'running'}
                onClick={() =>
                  handleExecute(
                    activeTab.id,
                    editorRef.current?.getExecutionText() ?? activeTab.queryText
                  )
                }
              >
                <PlayIcon size={12} />
                Run
                <kbd>{RUN_SHORTCUT}</kbd>
              </button>
            </div>
          </div>

          {saveName !== null && (
            <form
              className="query-workspace__savebar"
              onSubmit={(e) => {
                e.preventDefault()
                void handleSaveQuery()
              }}
            >
              <input
                type="text"
                aria-label="Saved query name"
                placeholder="Name this query…"
                value={saveName}
                autoFocus
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSaveName(null)
                }}
              />
              <button type="submit" className="btn--primary" disabled={!saveName.trim()}>
                Save query
              </button>
              <button type="button" className="btn--ghost" onClick={() => setSaveName(null)}>
                Cancel
              </button>
            </form>
          )}

          <QueryEditor
            key={activeTab.id}
            ref={editorRef}
            initialValue={activeTab.queryText}
            dialect={connections.find((c) => c.id === activeTab.connectionId)?.config.kind}
            onChange={(text) => updateTab(activeTab.id, (t) => ({ ...t, queryText: text }))}
            onExecute={(text) => handleExecute(activeTab.id, text)}
          />

          <EditorResizer {...editorHeight} />

          <QueryResultsView
            run={activeTab.run}
            exportState={activeTab.exportState}
            extractorSettings={extractorSettings}
            onExtractorSettingsChange={updateExtractorSettings}
            tableName={tableNameFor(activeTab)}
            onTableNameChange={(tableName) =>
              updateTab(activeTab.id, (t) => ({ ...t, tableNameOverride: tableName }))
            }
            onExportLoaded={(request) => void handleExportLoaded(activeTab.id, request)}
            onExportAll={(resultSet) => handleExportAll(activeTab.id, resultSet)}
            onCancelExport={() => handleCancelExport(activeTab.id)}
          />
        </div>
      )}
    </section>
  )
})

function ContainerPicker({
  list,
  fixedDatabase,
  value,
  onRetry,
  onChange
}: {
  list: ContainerList | undefined
  /** Set when the profile pins a database — only its containers are offered. */
  fixedDatabase: string | undefined
  value: QueryOptions | undefined
  onRetry: () => void
  onChange: (options: QueryOptions | undefined) => void
}): React.JSX.Element {
  const items =
    list?.status === 'ready'
      ? list.items.filter((item) => !fixedDatabase || item.database === fixedDatabase)
      : []
  const databases = [...new Set(items.map((item) => item.database))]
  const selected =
    value?.database && value.container ? `${value.database}${PICKER_SEPARATOR}${value.container}` : ''
  const selectedListed = items.some(
    (item) => `${item.database}${PICKER_SEPARATOR}${item.container}` === selected
  )
  const placeholder =
    list?.status === 'loading' || list === undefined
      ? 'Loading containers…'
      : list.status === 'unavailable'
        ? list.message
        : items.length === 0
          ? 'No containers found'
          : 'Select a container'

  function option(item: { database: string; container: string }): React.JSX.Element {
    return (
      <option
        key={`${item.database}${PICKER_SEPARATOR}${item.container}`}
        value={`${item.database}${PICKER_SEPARATOR}${item.container}`}
      >
        {item.container}
      </option>
    )
  }

  return (
    <label className="query-workspace__container">
      Container
      <select
        value={selected}
        // A failed load (usually "not connected yet") is retried on demand.
        onFocus={() => list?.status === 'unavailable' && onRetry()}
        onChange={(e) => {
          const [database, container] = e.target.value.split(PICKER_SEPARATOR)
          onChange(database && container ? { database, container } : undefined)
        }}
      >
        <option value="">{placeholder}</option>
        {/* Keep a container opened from the Object Explorer visible while the list loads. */}
        {selected && !selectedListed && (
          <option value={selected}>{value?.container}</option>
        )}
        {databases.length > 1
          ? databases.map((database) => (
              <optgroup key={database} label={database}>
                {items.filter((item) => item.database === database).map(option)}
              </optgroup>
            ))
          : items.map(option)}
      </select>
    </label>
  )
}
