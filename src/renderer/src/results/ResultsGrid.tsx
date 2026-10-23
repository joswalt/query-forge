import { useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { EXTRACTORS, type ExtractorId } from '@shared/extractors/extract'
import { isRecord } from '@shared/is-record'
import { formatCellValue } from './cell-format'
import { copyScopeForShortcut } from './copy-plan'

const ROW_HEIGHT_PX = 28

/** A copy the grid asks its parent to perform: a cell's raw value, or rows
 * through an Extractor (`undefined` = the Active Extractor). */
export type GridCopy =
  | { scope: 'cell'; value: unknown }
  | { scope: 'rows'; rows: unknown[]; extractorId?: ExtractorId }

interface ContextMenuState {
  x: number
  y: number
  rowIndex: number
  /** Opened in the lower half / right part of the window: the menu (and
   * its "Copy as ▸" submenu, which lists every Extractor) grows up / opens
   * to the left so it stays on screen. */
  openUp: boolean
  openLeft: boolean
}

/** Room the menu plus its submenu need to the right of the cursor. */
const MENU_WITH_SUBMENU_WIDTH_PX = 340

/**
 * The results grid (user stories 38-39): TanStack Table for column
 * model/resizing, TanStack Virtual for row virtualization (only visible
 * rows are mounted — `MAX_DISPLAY_ROWS` can hold tens of thousands of rows
 * without a proportional render cost). `columns` comes from the parent (the
 * union across all retained rows, `computeColumnUnion`, since Cosmos
 * documents are heterogeneous) so copy and export use exactly the columns
 * displayed here (Extractors story 45).
 *
 * The header row is a `position: sticky` child of the *same* scroll
 * container the virtualized body scrolls in — not a separate element
 * above it — so a horizontal scroll moves the header and body together
 * (it only stays pinned on the *vertical* axis). A sibling header outside
 * the scroll container would desync from resized/scrolled columns.
 *
 * Row/cell selection here is deliberately minimal: a click sets the
 * "active cell"; clicking a row number toggles that row into a multi-row
 * selection (plain click replaces the selection, Cmd/Ctrl-click extends
 * it). Cmd/Ctrl+C copies the selected rows through the Active Extractor, or
 * the active cell's raw value when no row is selected; Cmd/Ctrl+Shift+C
 * copies every loaded row (copy-plan.ts decides which). The right-click
 * menu offers the same explicitly, plus "Copy as ▸" for a one-off copy in
 * any other Extractor. The copying itself (clipboard, toast, size guard)
 * belongs to the parent via `onCopy`.
 */
export function ResultsGrid({
  rows,
  columns,
  streaming,
  onExpandCell,
  onCopy
}: {
  rows: unknown[]
  columns: string[]
  /** The run is still appending rows: copying "all loaded" would silently
   * get fewer rows than the run will produce (Extractors story 48). */
  streaming: boolean
  /** Open the JSON inspector for one cell's value (user story 41). */
  onExpandCell: (value: unknown) => void
  onCopy: (copy: GridCopy) => void
}): React.JSX.Element {
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
    onCopy({ scope: 'cell', value })
  }

  function selectedRowValues(): unknown[] {
    return [...selectedRows].sort((a, b) => a - b).map((i) => rows[i])
  }

  /** The rows a context-menu copy acts on: the selection when the
   * right-clicked row is part of it, otherwise just that row. */
  function contextRows(rowIndex: number): unknown[] {
    return selectedRows.has(rowIndex) ? selectedRowValues() : [rows[rowIndex]]
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
          const scope = copyScopeForShortcut({
            shift: e.shiftKey,
            selectedRowCount: selectedRows.size
          })
          if (scope === 'cell') copyActiveCell()
          else if (scope === 'selected') onCopy({ scope: 'rows', rows: selectedRowValues() })
          else if (!streaming) onCopy({ scope: 'rows', rows })
        }
      }}
      onClick={() => setContextMenu(null)}
    >
      {selectedRows.size > 0 && (
        <div className="results-grid__toolbar">
          <span>{selectedRows.size} row(s) selected</span>
          <button
            type="button"
            className="btn--ghost"
            onClick={() => onCopy({ scope: 'rows', rows: selectedRowValues() })}
          >
            Copy selected rows
          </button>
        </div>
      )}

      <div
        ref={parentRef}
        tabIndex={0}
        className="results-grid__scroller"
        style={{ overflow: 'auto', position: 'relative' }}
      >
        <div
          className="results-grid__header"
          style={{
            display: 'flex',
            position: 'sticky',
            top: 0,
            zIndex: 1,
            width: table.getTotalSize(),
            // The header needs an opaque background (set in results.css on
            // `.results-grid__header`): it is a sticky sibling of the
            // virtualized rows inside the *same* scroll container (see
            // class doc), so without one rows scrolling vertically would
            // show through it.
          }}
        >
          {table.getHeaderGroups().map((headerGroup) =>
            headerGroup.headers.map((header) => (
              <div
                key={header.id}
                className="results-grid__hcell"
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
                className={`results-grid__row${isSelected ? ' is-selected' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'flex'
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
                      className={[
                        'results-grid__cell',
                        isRowNumber ? 'is-rownum' : '',
                        rawValue === null || rawValue === undefined ? (isRowNumber ? '' : 'is-null') : '',
                        typeof rawValue === 'number' ? 'is-number' : '',
                        isExpandable ? 'is-object' : '',
                        isActive ? 'is-active' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        width: cell.column.getSize(),
                        flexShrink: 0
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
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          rowIndex: virtualRow.index,
                          openUp: e.clientY > window.innerHeight / 2,
                          openLeft: e.clientX > window.innerWidth - MENU_WITH_SUBMENU_WIDTH_PX
                        })
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
          className={[
            'results-grid__context-menu',
            contextMenu.openUp ? 'is-open-up' : '',
            contextMenu.openLeft ? 'is-open-left' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            ...(contextMenu.openUp
              ? { bottom: window.innerHeight - contextMenu.y }
              : { top: contextMenu.y })
          }}
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
                onCopy({ scope: 'rows', rows: contextRows(contextMenu.rowIndex) })
                setContextMenu(null)
              }}
            >
              {selectedRows.has(contextMenu.rowIndex) && selectedRows.size > 1
                ? `Copy ${selectedRows.size} selected rows`
                : 'Copy row'}
            </button>
          </li>
          <li className="results-grid__submenu-host">
            <button type="button" aria-haspopup="menu">
              Copy as <span aria-hidden="true">▸</span>
            </button>
            <ul className="results-grid__context-menu results-grid__submenu" role="menu">
              {EXTRACTORS.map((extractor) => (
                <li key={extractor.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCopy({
                        scope: 'rows',
                        rows: contextRows(contextMenu.rowIndex),
                        extractorId: extractor.id
                      })
                      setContextMenu(null)
                    }}
                  >
                    {extractor.label}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        </ul>
      )}
    </div>
  )
}
