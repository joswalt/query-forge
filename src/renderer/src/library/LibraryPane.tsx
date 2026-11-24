import { useCallback, useId, useRef, useState } from 'react'

export type LibraryTab = 'saved-queries' | 'history'

const STORAGE_KEY = 'queryforge.ui.libraryTab'
const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'saved-queries', label: 'Saved queries' },
  { id: 'history', label: 'History' }
]

function read(): LibraryTab {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'saved-queries' ? 'saved-queries' : 'history'
  } catch {
    return 'history'
  }
}

/** Which library tab is showing, remembered across launches. */
export function useLibraryTab(): [LibraryTab, (tab: LibraryTab) => void] {
  const [tab, setState] = useState(read)
  const setTab = useCallback((next: LibraryTab) => {
    setState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Best-effort only.
    }
  }, [])
  return [tab, setTab]
}

/**
 * The sidebar's lower pane: Saved Queries and Query History, one at a time.
 * Both stay mounted while hidden, so a history search survives switching.
 */
export function LibraryPane({
  tab,
  onTabChange,
  savedCount,
  saved,
  history
}: {
  tab: LibraryTab
  onTabChange: (tab: LibraryTab) => void
  savedCount: number
  saved: React.ReactNode
  history: React.ReactNode
}): React.JSX.Element {
  const baseId = useId()
  const tabRefs = useRef<Partial<Record<LibraryTab, HTMLButtonElement | null>>>({})

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const index = TABS.findIndex((t) => t.id === tab)
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]
    onTabChange(next.id)
    tabRefs.current[next.id]?.focus()
    event.preventDefault()
  }

  return (
    <section className="library" aria-label="Library">
      <div className="library__tabs" role="tablist" aria-label="Library" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`${baseId}-${t.id}-tab`}
            aria-selected={tab === t.id}
            aria-controls={`${baseId}-${t.id}-panel`}
            tabIndex={tab === t.id ? 0 : -1}
            className="library__tab"
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
            {t.id === 'saved-queries' && savedCount > 0 && (
              <span className="library__count">{savedCount}</span>
            )}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div
          key={t.id}
          id={`${baseId}-${t.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${baseId}-${t.id}-tab`}
          className="library__panel"
          hidden={tab !== t.id}
        >
          {t.id === 'saved-queries' ? saved : history}
        </div>
      ))}
    </section>
  )
}
