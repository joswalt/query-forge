import { useEffect, useId, useState } from 'react'
import { ChevronIcon } from './icons'

const STORAGE_PREFIX = 'queryforge.ui.group.'

/** Dispatched on `window` (detail: group name) to open a group from outside,
 * e.g. when the collapsed rail reveals a connection inside it. */
export const OPEN_GROUP_EVENT = 'queryforge:open-group'

function readOpen(name: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + name) !== '0'
  } catch {
    return true
  }
}

interface Props {
  name: string
  count: number
  /** Live sessions inside the group; stays visible while collapsed. */
  connectedCount: number
  /** Keeps the group open regardless of the remembered state (e.g. while a
   * member is being edited, so its form can't be hidden). */
  forceOpen?: boolean
  children: React.ReactNode
}

/**
 * A named group of connections with a disclosure header. Open/closed is
 * remembered per group name. The body stays mounted while collapsed so an
 * in-progress edit form survives.
 */
export function ConnectionGroup({
  name,
  count,
  connectedCount,
  forceOpen = false,
  children
}: Props): React.JSX.Element {
  const [remembered, setRemembered] = useState(() => readOpen(name))
  const open = remembered || forceOpen
  const bodyId = useId()

  function remember(next: boolean): void {
    setRemembered(next)
    try {
      localStorage.setItem(STORAGE_PREFIX + name, next ? '1' : '0')
    } catch {
      // Best-effort — losing the remembered state must never break the UI.
    }
  }

  useEffect(() => {
    function onOpenRequest(event: Event): void {
      if ((event as CustomEvent<string>).detail === name) remember(true)
    }
    window.addEventListener(OPEN_GROUP_EVENT, onOpenRequest)
    return () => window.removeEventListener(OPEN_GROUP_EVENT, onOpenRequest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  return (
    <div className="conn-group" data-open={open}>
      <h3 className="conn-group__title">
        <button
          type="button"
          className="btn--ghost conn-group__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => remember(!open)}
        >
          <ChevronIcon size={10} />
          {name}
          <span className="conn-group__count">{count}</span>
          {!open && connectedCount > 0 && (
            <span className="conn-group__live">{connectedCount} connected</span>
          )}
        </button>
      </h3>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
