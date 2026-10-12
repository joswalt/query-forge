import { useEffect, useId, useState } from 'react'
import { ChevronIcon } from './icons'

const STORAGE_PREFIX = 'queryforge.ui.section.'

/** Dispatched on `window` (detail: section id) to open a section from outside,
 * e.g. from the collapsed sidebar rail. */
export const OPEN_SECTION_EVENT = 'queryforge:open-section'

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + id)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

interface Props {
  /** Stable key — the open/closed choice is remembered under it. */
  id: string
  title: string
  /** Small muted number beside the title (e.g. how many saved queries). */
  count?: number
  /** Header-level actions. Rendered beside — not inside — the toggle button. */
  actions?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}

/**
 * Sidebar section with a disclosure header. The body stays mounted while
 * collapsed (just hidden) so panels keep their state — a history search or
 * a half-filled form survives a collapse.
 */
export function Collapsible({
  id,
  title,
  count,
  actions,
  defaultOpen = true,
  children
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen))
  const bodyId = useId()

  function remember(next: boolean): void {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, next ? '1' : '0')
    } catch {
      // Best-effort — losing the remembered state must never break the UI.
    }
  }

  function toggle(): void {
    const next = !open
    setOpen(next)
    remember(next)
  }

  useEffect(() => {
    function onOpenRequest(event: Event): void {
      if ((event as CustomEvent<string>).detail !== id) return
      setOpen(true)
      remember(true)
    }
    window.addEventListener(OPEN_SECTION_EVENT, onOpenRequest)
    return () => window.removeEventListener(OPEN_SECTION_EVENT, onOpenRequest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return (
    <section id={`section-${id}`} className="sidebar__section collapsible" data-open={open}>
      <div className="section-head">
        <h2 className="collapsible__title">
          <button
            type="button"
            className="btn--ghost collapsible__toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <ChevronIcon size={12} />
            {title}
            {count !== undefined && count > 0 && <span className="collapsible__count">{count}</span>}
          </button>
        </h2>
        {actions}
      </div>
      <div id={bodyId} className="collapsible__body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}
