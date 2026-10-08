import { useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { computeColumnUnion } from '@shared/column-union'
import { isRecord } from '@shared/is-record'
import { buildRowCopyText, buildRowsCopyText, formatCellValue } from './cell-format'

const ROW_HEIGHT_PX = 28
const GRID_HEIGHT_PX = 360

interface ContextMenuState {
  x: number
  y: number
  rowIndex: number
}

/**
 * The results grid (user stories 38-39): TanStack Table for column
 * model/resizing, TanStack Virtual for row virtualization (only visible
 * rows are mounted — `MAX_DISPLAY_ROWS` can hold tens of thousands of rows
 * without a proportional render cost). Columns are the union across all
 * retained rows (`computeColumnUnion`), not just row 0, since Cosmos
 * documents are heterogeneous.
 *
 * The header row is a `position: sticky` child of the *same* scroll
 * container the virtualized body scrolls in — not a separate element
 * above it — so a horizontal scroll moves the header and body together
 * (it only stays pinned on the *vertical* axis). A sibling header outside
 * the scroll container would desync from resized/scrolled columns.
 *
 * Row/cell selection here is deliberately minimal: a click sets the
 * "active cell" (Cmd/Ctrl+C copies its value); clicking a row number
 * toggles that row into a multi-row selection (plain click replaces the
 * selection, Cmd/Ctrl-click extends it) for "copy selected rows." A
 * right-click context menu offers the same two actions explicitly. This
 * covers user story 39's "cell / selected rows / selected values" with two
 * concrete mechanisms (cell copy, row copy) rather than inventing a third,
 * undocumented selection model.
 */
export function ResultsGrid({
  rows,
  onExpandCell
}: {
  rows: unknown[]
  /** Open the JSON inspector for one cell's value (user story 41). */
  onExpandCell: (value: unknown) => void
}): React.JSX.Element {
  const columns = useMemo(() => computeColumnUnion(rows), [rows])
  const [activeCell, setActiveCell] = useState<{ rowIndex: number; columnId: string } | null>(
    null
  )
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)

  const tableColumns = useMemo<ColumnDef<unknown>[]>(() => {
    const rowNumberColumn: ColumnDef<unknown> = {
      id: '__row_number__',
      header: '#',
      size: 48,
      enableResizing: false,
      cell: (info) => info.row.index + 1
    }
    const dataColumns: ColumnDef<unknown>[] = columns.map((column) => ({
      id: column,
      header: column,
      size: 160,
      accessorFn: (row) => (isRecord(row) ? row[column] : undefined)
    }))
    return [rowNumberColumn, ...dataColumns]
  }, [columns])

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    columnResizeMode: 'onChange',
    getCoreRowModel: getCoreRowModel()
  })

  const tableRows = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10
  })

  function copyActiveCell(): void {
    if (!activeCell) return
    const row = rows[activeCell.rowIndex]
    const value =
      activeCell.columnId === '__row_number__'
        ? activeCell.rowIndex + 1
        : isRecord(row)
          ? row[activeCell.columnId]
          : undefined
    void navigator.clipboard.writeText(formatCellValue(value))
  }

  function copyRow(rowIndex: number): void {
    void navigator.clipboard.writeText(buildRowCopyText(rows[rowIndex], columns))
  }

  function copySelectedRows(): void {
    const ordered = [...selectedRows].sort((a, b) => a - b)
    void navigator.clipboard.writeText(buildRowsCopyText(ordered.map((i) => rows[i]), columns))
  }

  function toggleRowSelection(rowIndex: number, extend: boolean): void {
    setSelectedRows((prev) => {
      const next = extend ? new Set(prev) : new Set<number>()
      if (next.has(rowIndex)) next.delete(rowIndex)
      else next.add(rowIndex)
      return next
    })
  }

  return (
    <div
      className="results-grid"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
          e.preventDefault()
          copyActiveCell()
        }
      }}
      onClick={() => setContextMenu(null)}
    >
      {selectedRows.size > 0 && (
        <div className="results-grid__toolbar">
          <span>{selectedRows.size} row(s) selected</span>
          <button type="button" onClick={copySelectedRows}>
            Copy selected rows
          </button>
        </div>
      )}

      <div
        ref={parentRef}
        tabIndex={0}
        style={{ height: GRID_HEIGHT_PX, overflow: 'auto', position: 'relative' }}
      >
        <div
          className="results-grid__header"
          style={{
            display: 'flex',
            position: 'sticky',
            top: 0,
            zIndex: 1,
            width: table.getTotalSize(),
            // An opaque background is load-bearing, not decorative: this
            // header is a sticky sibling of the virtualized rows inside
            // the *same* scroll container (see class doc), so without one
            // rows scrolling vertically would show through it.
            background: 'Canvas'
          }}
        >
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => (
              <div
                key={header.id}
                style={{ width: header.getSize(), position: 'relative', flexShrink: 0 }}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {header.column.getCanResize() && (
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className="results-grid__resize-handle"
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: 0,
                      height: '100%',
                      width: 4,
                      cursor: 'col-resize'
                    }}
                  />
                )}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: table.getTotalSize(),
            position: 'relative'
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = tableRows[virtualRow.index]
            const isSelected = selectedRows.has(virtualRow.index)
            return (
              <div
                key={row.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'flex',
                  background: isSelected ? 'rgba(0,0,0,0.08)' : undefined
                }}
              >
                {row.getVisibleCells().map((cell) => {
                  const isRowNumber = cell.column.id === '__row_number__'
                  const rawValue = isRowNumber ? undefined : cell.getValue()
                  const isExpandable =
                    !isRowNumber && typeof rawValue === 'object' && rawValue !== null
                  const isActive =
                    activeCell?.rowIndex === virtualRow.index &&
                    activeCell.columnId === cell.column.id

                  return (
                    <div
                      key={cell.id}
                      style={{
                        width: cell.column.getSize(),
                        flexShrink: 0,
                        outline: isActive ? '1px solid currentColor' : undefined
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (isRowNumber) {
                          toggleRowSelection(virtualRow.index, e.metaKey || e.ctrlKey || e.shiftKey)
                        } else {
                          setActiveCell({ rowIndex: virtualRow.index, columnId: cell.column.id })
                        }
                      }}
                      onDoubleClick={() => {
                        if (isExpandable) onExpandCell(rawValue)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        // Right-clicking a cell must make *that* cell the
                        // active one before the menu's "Copy cell" reads
                        // it — otherwise "Copy cell" silently copies
                        // whatever was last left-clicked (or nothing).
                        if (!isRowNumber) {
                          setActiveCell({ rowIndex: virtualRow.index, columnId: cell.column.id })
                        }
                        setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: virtualRow.index })
                      }}
                    >
                      {isRowNumber
                        ? flexRender(cell.column.columnDef.cell, cell.getContext())
                        : formatCellValue(rawValue)}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {contextMenu && (
        <ul
          className="results-grid__context-menu"
          style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, listStyle: 'none' }}
          onClick={(e) => e.stopPropagation()}
        >
          <li>
            <button
              type="button"
              onClick={() => {
                copyActiveCell()
                setContextMenu(null)
              }}
            >
              Copy cell
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={() => {
                copyRow(contextMenu.rowIndex)
                setContextMenu(null)
              }}
            >
              Copy row
            </button>
          </li>
        </ul>
      )}
    </div>
  )
}
