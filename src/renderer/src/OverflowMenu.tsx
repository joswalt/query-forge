import { useEffect, useId, useRef, useState } from 'react'
import { MoreIcon } from './icons'

export interface OverflowMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

/** "⋯" button opening a small action menu. Closes on outside click, Escape,
 * or after an item is chosen; arrow keys move between items. */
export function OverflowMenu({
  label,
  items
}: {
  /** Accessible name for the trigger, e.g. "More actions for opt-ecom (stg)". */
  label: string
  items: OverflowMenuItem[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const entries = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = entries.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    entries[(next + entries.length) % entries.length]?.focus()
    event.preventDefault()
  }

  return (
    <div className="overflow-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="btn--ghost overflow-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title="More actions"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <ul id={menuId} className="overflow-menu__list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={`btn--ghost${item.danger ? ' btn--danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
