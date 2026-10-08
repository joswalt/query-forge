import { JsonTree } from './JsonTree'

/**
 * Expands one table cell's object/array value into the same JSON tree used
 * by the full JSON view (user story 41) — inline, not a separate modal
 * component family, so a cell and the whole-result JSON view always look
 * the same.
 */
export function CellInspector({
  value,
  onClose
}: {
  value: unknown
  onClose: () => void
}): React.JSX.Element {
  async function handleCopy(): Promise<void> {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
  }

  return (
    <div className="cell-inspector" role="dialog" aria-label="Cell value">
      <div className="cell-inspector__toolbar">
        <button type="button" onClick={handleCopy}>
          Copy
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <JsonTree value={value} />
    </div>
  )
}
