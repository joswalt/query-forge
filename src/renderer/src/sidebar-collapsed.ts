import { useCallback, useState } from 'react'

const STORAGE_KEY = 'queryforge.ui.sidebarCollapsed'

/** Width of the collapsed rail, in px. */
export const RAIL_WIDTH = 52

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export interface SidebarCollapsed {
  collapsed: boolean
  setCollapsed: (collapsed: boolean) => void
  toggle: () => void
}

/** Whether the sidebar is collapsed to its rail, remembered across launches. */
export function useSidebarCollapsed(): SidebarCollapsed {
  const [collapsed, setState] = useState(read)

  const setCollapsed = useCallback((next: boolean) => {
    setState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      // Best-effort only.
    }
  }, [])

  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed])
  return { collapsed, setCollapsed, toggle }
}
