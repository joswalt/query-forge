import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'queryforge.ui.sidebarSplit'
/** Share of the sidebar's height given to Connections; the rest is the library pane. */
export const SPLIT_DEFAULT = 0.55
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8
const KEY_STEP = 0.05

function clamp(share: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share))
}

function read(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : SPLIT_DEFAULT
  } catch {
    return SPLIT_DEFAULT
  }
}

export interface SidebarSplit {
  /** Connections' share of the height, 0.2 to 0.8. */
  share: number
  setShare: (share: number) => void
  reset: () => void
}

/** How the sidebar's height divides between Connections and the library
 * pane, remembered across launches. */
export function useSidebarSplit(): SidebarSplit {
  const [share, setState] = useState(read)
  const setShare = useCallback((next: number) => {
    const value = clamp(next)
    setState(value)
    try {
      localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // Best-effort only.
    }
  }, [])
  const reset = useCallback(() => setShare(SPLIT_DEFAULT), [setShare])
  return { share, setShare, reset }
}

/**
 * Drag handle between Connections and the library pane. Pointer-drag,
 * arrow keys, Home/End for the limits, double-click to reset.
 */
export function SidebarSplitter({
  split,
  containerRef
}: {
  split: SidebarSplit
  /** The element whose height is being divided. */
  containerRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { share, setShare, reset } = split
  const [dragging, setDragging] = useState(false)
  const rectRef = useRef<DOMRect | null>(null)

  useEffect(() => {
    if (!dragging) return
    function onMove(event: PointerEvent): void {
      const rect = rectRef.current
      if (rect && rect.height > 0) setShare((event.clientY - rect.top) / rect.height)
    }
    function onUp(): void {
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, setShare])

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowUp') setShare(share - KEY_STEP)
    else if (event.key === 'ArrowDown') setShare(share + KEY_STEP)
    else if (event.key === 'Home') setShare(SPLIT_MIN)
    else if (event.key === 'End') setShare(SPLIT_MAX)
    else return
    event.preventDefault()
  }

  return (
    <div
      className="sidebar-splitter"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize connections and library"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={SPLIT_MIN * 100}
      aria-valuemax={SPLIT_MAX * 100}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        rectRef.current = containerRef.current?.getBoundingClientRect() ?? null
        setDragging(true)
      }}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}
