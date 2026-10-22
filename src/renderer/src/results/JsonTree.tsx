import {
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  ancestorPaths,
  buildJsonNode,
  findJsonMatches,
  nestedContainerPaths,
  type JsonMatch,
  type JsonNode
} from './json-tree-model'

/**
 * Hand-rolled collapsible, syntax-highlighted JSON renderer (user stories
 * 40-41) — no new dependency (CodeMirror's JSON mode would add another
 * `@codemirror/lang-json` package for a feature this small). Used both for
 * the full JSON results view and the single-cell inspector, so both present
 * nested documents identically.
 *
 * Every nested object/array collapses on its own (toggle or key click);
 * strings holding JSON objects/arrays render as nested nodes too (see
 * `parseJsonString`). Collapse state lives here, keyed by node path, so
 * "Collapse all" and Find (which expands the current match's ancestors)
 * can drive it. Nodes read collapse/Find state through `TreeStore`
 * subscriptions rather than props, so a toggle or keystroke re-renders only
 * the nodes whose state changed, not all of a 500-row result. Collapse state survives `value` changing (rows streaming
 * into a running query); callers remount via `key` for an unrelated value.
 * `actions` renders at the start of the tree's toolbar, so a
 * caller's buttons share the row with Find instead of stacking a second one.
 */
export function JsonTree({
  value,
  actions
}: {
  value: unknown
  actions?: React.ReactNode
}): React.JSX.Element {
  const root = useMemo(() => buildJsonNode(value), [value])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const matches = useMemo(() => findJsonMatches(root, deferredQuery), [root, deferredQuery])
  const [currentIndex, setCurrentIndex] = useState(0)
  const current: JsonMatch | undefined = matches[Math.min(currentIndex, matches.length - 1)]

  const treeRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const [store] = useState(() => new TreeStore(toggle))
  const needle = deferredQuery.trim().toLowerCase()
  useLayoutEffect(() => store.update(collapsed, needle, current), [store, collapsed, needle, current])

  useEffect(() => setCurrentIndex(0), [matches])

  // Expand whatever hides the current match; its `<mark>` scrolls itself
  // into view once mounted (see `Highlighted`).
  useEffect(() => {
    if (!current) return
    store.scrollRequested = true
    setCollapsed((prev) => {
      const hidden = ancestorPaths(current.path).filter((path) => prev.has(path))
      if (hidden.length === 0) return prev
      const next = new Set(prev)
      for (const path of hidden) next.delete(path)
      return next
    })
  }, [store, current])

  function toggle(path: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function step(delta: 1 | -1): void {
    if (matches.length === 0) return
    const from = Math.min(currentIndex, matches.length - 1)
    setCurrentIndex((from + delta + matches.length) % matches.length)
    store.scrollRequested = true
  }

  function handlePanelKeyDown(event: React.KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      findRef.current?.focus()
      findRef.current?.select()
    }
  }

  function handleFindKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      setQuery('')
      treeRef.current?.focus()
    }
  }

  return (
    <div className="json-tree-panel" onKeyDown={handlePanelKeyDown}>
      <div className="json-tree-toolbar">
        {actions}
        <span className="json-tree-toolbar__spacer" />
        <button type="button" className="btn--ghost" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button
          type="button"
          className="btn--ghost"
          onClick={() => setCollapsed(new Set(nestedContainerPaths(root)))}
        >
          Collapse all
        </button>
        <div className="json-find" role="search">
          <input
            ref={findRef}
            type="search"
            placeholder="Find"
            aria-label="Find in JSON"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleFindKeyDown}
          />
          <span className="json-find__count" aria-live="polite">
            {matches.length > 0
              ? `${Math.min(currentIndex, matches.length - 1) + 1} of ${matches.length}`
              : needle !== ''
                ? 'No matches'
                : ''}
          </span>
          <button
            type="button"
            className="btn--ghost"
            aria-label="Previous match"
            disabled={matches.length === 0}
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn--ghost"
            aria-label="Next match"
            disabled={matches.length === 0}
            onClick={() => step(1)}
          >
            ↓
          </button>
        </div>
      </div>
      <div className="json-tree" ref={treeRef} tabIndex={-1}>
        <NodeView node={root} store={store} last />
      </div>
    </div>
  )
}

/**
 * Collapse and Find state for the nodes of one tree, mirrored from
 * `JsonTree`'s React state. Each node subscribes to just the slice it
 * renders (its collapsed flag, its own highlight), so `useSyncExternalStore`
 * re-renders only nodes whose slice changed.
 */
class TreeStore {
  collapsed: ReadonlySet<string> = new Set()
  /** Lower-cased, trimmed Find query; `''` when not searching. */
  needle = ''
  current: JsonMatch | undefined
  /** Set when the current match changes; the current `<mark>` clears it after scrolling. */
  scrollRequested = false
  private listeners = new Set<() => void>()

  constructor(readonly toggle: (path: string) => void) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(collapsed: ReadonlySet<string>, needle: string, current: JsonMatch | undefined): void {
    this.collapsed = collapsed
    this.needle = needle
    this.current = current
    for (const listener of this.listeners) listener()
  }

  /**
   * `''` when `text` doesn't contain the query, else `'m:'` (a match) or
   * `'c:'` (the current match) followed by the query. A string, so
   * `useSyncExternalStore` compares it by value.
   */
  highlight(text: string, path: string, part: JsonMatch['part']): string {
    if (this.needle === '' || !text.toLowerCase().includes(this.needle)) return ''
    const isCurrent = this.current?.path === path && this.current.part === part
    return (isCurrent ? 'c:' : 'm:') + this.needle
  }
}

const NodeView = memo(function NodeView({
  node,
  entryKey,
  last,
  store
}: {
  node: JsonNode
  /** The key this node sits under in its parent; absent for the root. */
  entryKey?: string
  last: boolean
  store: TreeStore
}): React.JSX.Element {
  const comma = last ? '' : ','
  const isToggleable = node.kind === 'container' && node.entries.length > 0
  const isCollapsed = useSyncExternalStore(store.subscribe, () => store.collapsed.has(node.path))

  const keyLabel = entryKey !== undefined && (
    <span
      className={isToggleable ? 'json-key json-key--toggle' : 'json-key'}
      onClick={
        isToggleable
          ? () => {
              // A drag-select across the key shouldn't also collapse it.
              if (window.getSelection()?.isCollapsed !== false) store.toggle(node.path)
            }
          : undefined
      }
    >
      &quot;
      <Highlighted text={entryKey} path={node.path} part="key" store={store} />
      &quot;:{' '}
    </span>
  )

  if (node.kind === 'scalar') {
    const text = <Highlighted text={node.text} path={node.path} part="value" store={store} />
    return (
      <div className="json-line">
        <span className="json-toggle-spacer" />
        {keyLabel}
        <span className={`json-${node.type}`}>
          {node.type === 'string' ? (
            <>
              &quot;{text}&quot;
            </>
          ) : (
            text
          )}
        </span>
        {comma}
      </div>
    )
  }

  const open = node.bracket
  const close = node.bracket === '{' ? '}' : ']'
  const parsedHint = node.parsedFromString && (
    <span
      className="json-parsed-hint"
      title="Stored as a JSON string, shown parsed. Copy and Save keep the original string."
    >
      string
    </span>
  )

  if (!isToggleable) {
    return (
      <div className="json-line">
        <span className="json-toggle-spacer" />
        {keyLabel}
        {open}
        {close}
        {comma}
        {parsedHint}
      </div>
    )
  }

  const count = node.entries.length
  return (
    <div className="json-node">
      <div className="json-line">
        <button
          type="button"
          className="json-toggle"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          onClick={() => store.toggle(node.path)}
        >
          {isCollapsed ? '▸' : '▾'}
        </button>
        {keyLabel}
        {open}
        {isCollapsed && (
          <>
            <span className="json-collapsed-summary">
              {' '}
              … {count} {node.bracket === '[' ? 'item' : 'key'}
              {count === 1 ? '' : 's'}{' '}
            </span>
            {close}
            {comma}
          </>
        )}
        {parsedHint}
      </div>
      {!isCollapsed && (
        <>
          <div className="json-entries">
            {node.entries.map((entry, index) => (
              <NodeView
                key={entry.key}
                node={entry.node}
                entryKey={entry.key}
                last={index === count - 1}
                store={store}
              />
            ))}
          </div>
          <div className="json-line">
            <span className="json-toggle-spacer" />
            {close}
            {comma}
          </div>
        </>
      )}
    </div>
  )
})

/** `text` with every case-insensitive occurrence of the Find query wrapped in a `<mark>`. */
function Highlighted({
  text,
  path,
  part,
  store
}: {
  text: string
  path: string
  part: JsonMatch['part']
  store: TreeStore
}): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, () => store.highlight(text, path, part))
  const current = state.startsWith('c:')
  const firstMark = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    if (current && store.scrollRequested) {
      firstMark.current?.scrollIntoView({ block: 'center' })
      store.scrollRequested = false
    }
  }, [current, store])

  if (state === '') return <>{text}</>
  const needle = state.slice(2)
  const lower = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark
        key={at}
        ref={from === 0 ? firstMark : undefined}
        className={current ? 'json-match json-match--current' : 'json-match'}
      >
        {text.slice(at, at + needle.length)}
      </mark>
    )
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}
