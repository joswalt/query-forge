import { useState } from 'react'

/**
 * Hand-rolled collapsible, syntax-highlighted JSON renderer (user stories
 * 40-41) — no new dependency (CodeMirror's JSON mode would add another
 * `@codemirror/lang-json` package for a feature this small; styling is via
 * plain class names, matching the rest of the renderer's current
 * no-CSS-file state — visual styling is later UI-polish work, not this
 * slice). Used both for the full JSON results view and the single-cell
 * inspector, so both present nested documents identically.
 */
export function JsonTree({ value }: { value: unknown }): React.JSX.Element {
  return <div className="json-tree">{renderValue(value)}</div>
}

function renderValue(value: unknown): React.JSX.Element {
  if (value === null) return <span className="json-null">null</span>
  if (Array.isArray(value)) {
    return (
      <JsonContainer
        open="["
        close="]"
        entries={value.map((item, index) => ({ key: String(index), value: item }))}
      />
    )
  }
  if (typeof value === 'object') {
    return (
      <JsonContainer
        open="{"
        close="}"
        entries={Object.entries(value).map(([key, entryValue]) => ({ key, value: entryValue }))}
      />
    )
  }
  if (typeof value === 'string') return <span className="json-string">&quot;{value}&quot;</span>
  if (typeof value === 'number') return <span className="json-number">{value}</span>
  if (typeof value === 'boolean') return <span className="json-boolean">{String(value)}</span>
  return <span className="json-undefined">undefined</span>
}

function JsonContainer({
  open,
  close,
  entries
}: {
  open: string
  close: string
  entries: { key: string; value: unknown }[]
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)

  if (entries.length === 0) {
    return (
      <span>
        {open}
        {close}
      </span>
    )
  }

  return (
    <span className="json-container">
      <button
        type="button"
        className="json-toggle"
        aria-label={collapsed ? 'Expand' : 'Collapse'}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? '▶' : '▼'}
      </button>
      {open}
      {collapsed ? (
        <span className="json-collapsed-summary">
          {' '}
          … {entries.length} item{entries.length === 1 ? '' : 's'} {close}
        </span>
      ) : (
        <div className="json-entries" style={{ paddingLeft: 16 }}>
          {entries.map(({ key, value }, index) => (
            <div key={key} className="json-entry">
              <span className="json-key">&quot;{key}&quot;: </span>
              {renderValue(value)}
              {index < entries.length - 1 ? ',' : ''}
            </div>
          ))}
          <div>{close}</div>
        </div>
      )}
    </span>
  )
}
