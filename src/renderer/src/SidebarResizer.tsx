import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'queryforge.ui.sidebarWidth'
export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 640
export const SIDEBAR_DEFAULT = 300
const KEY_STEP = 16

function clamp(width: number): number {
  // Never let the sidebar take more than half the window — the editor needs room.
  const ceiling = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth / 2)))
  return Math.round(Math.min(ceiling, Math.max(SIDEBAR_MIN, width)))
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export interface SidebarWidth {
  width: number
  setWidth: (width: number) => void
  reset: () => void
}

/** Sidebar width, remembered across launches. */
export function useSidebarWidth(): SidebarWidth {
  const [width, setWidthState] = useState(readWidth)

  const setWidth = useCallback((next: number) => {
    const value = clamp(next)
    setWidthState(value)
    try {
      localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // Best-effort only.
    }
  }, [])

  const reset = useCallback(() => setWidth(SIDEBAR_DEFAULT), [setWidth])
  return { width, setWidth, reset }
}

/**
 * Drag handle on the sidebar's right edge. Pointer-drag, arrow keys
 * (Shift = larger step), Home/End for min/max, double-click to reset.
 */
export function SidebarResizer({ width, setWidth, reset }: SidebarWidth): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const originRef = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    if (!dragging) return
    function onMove(event: PointerEvent): void {
      const origin = originRef.current
      if (origin) setWidth(origin.width + event.clientX - origin.x)
    }
    function onUp(): void {
      setDragging(false)
      originRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // Keep the resize cursor and block text selection for the whole drag,
    // even when the pointer leaves the thin handle.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, setWidth])

  function onKeyDown(event: React.KeyboardEvent): void {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP
    if (event.key === 'ArrowLeft') setWidth(width - step)
    else if (event.key === 'ArrowRight') setWidth(width + step)
    else if (event.key === 'Home') setWidth(SIDEBAR_MIN)
    else if (event.key === 'End') setWidth(SIDEBAR_MAX)
    else return
    event.preventDefault()
  }

  return (
    <div
      className="sidebar-resizer"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        originRef.current = { x: event.clientX, width }
        setDragging(true)
      }}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}
