import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'queryforge.ui.editorHeight'
export const EDITOR_MIN = 120
export const EDITOR_MAX = 800
export const EDITOR_DEFAULT = 260
const KEY_STEP = 16

function clamp(height: number): number {
  // Leave room for the toolbar and at least a sliver of results.
  const ceiling = Math.min(EDITOR_MAX, Math.max(EDITOR_MIN, window.innerHeight - 260))
  return Math.round(Math.min(ceiling, Math.max(EDITOR_MIN, height)))
}

function readHeight(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : EDITOR_DEFAULT
  } catch {
    return EDITOR_DEFAULT
  }
}

export interface EditorHeight {
  height: number
  setHeight: (height: number) => void
  reset: () => void
}

/** Query editor height (editor/results split), remembered across launches. */
export function useEditorHeight(): EditorHeight {
  const [height, setHeightState] = useState(readHeight)

  const setHeight = useCallback((next: number) => {
    const value = clamp(next)
    setHeightState(value)
    try {
      localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // Best-effort only.
    }
  }, [])

  const reset = useCallback(() => setHeight(EDITOR_DEFAULT), [setHeight])
  return { height, setHeight, reset }
}

/**
 * Horizontal drag handle between the query editor and the results (user
 * story 54, resizable panels). Pointer-drag, ArrowUp/Down (Shift = larger
 * step), Home/End for min/max, double-click to reset.
 */
export function EditorResizer({ height, setHeight, reset }: EditorHeight): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const originRef = useRef<{ y: number; height: number } | null>(null)

  useEffect(() => {
    if (!dragging) return
    function onMove(event: PointerEvent): void {
      const origin = originRef.current
      if (origin) setHeight(origin.height + event.clientY - origin.y)
    }
    function onUp(): void {
      setDragging(false)
      originRef.current = null
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
  }, [dragging, setHeight])

  function onKeyDown(event: React.KeyboardEvent): void {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP
    if (event.key === 'ArrowUp') setHeight(height - step)
    else if (event.key === 'ArrowDown') setHeight(height + step)
    else if (event.key === 'Home') setHeight(EDITOR_MIN)
    else if (event.key === 'End') setHeight(EDITOR_MAX)
    else return
    event.preventDefault()
  }

  return (
    <div
      className="editor-resizer"
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize query editor"
      aria-valuenow={height}
      aria-valuemin={EDITOR_MIN}
      aria-valuemax={EDITOR_MAX}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        originRef.current = { y: event.clientY, height }
        setDragging(true)
      }}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  )
}
