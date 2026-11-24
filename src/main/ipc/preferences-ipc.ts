import { BrowserWindow, ipcMain } from 'electron'
import type { Preferences, PreferencesStore } from '../local-storage/preferences-store'

/** Registers the Preferences read/update surface (e.g. user story 53's
 * query-history-text opt-in, user story 54's theme choice). Every update is
 * broadcast as `preferences:updated`, so a setting changed in one place
 * (the history options menu) takes effect everywhere at once: turning the
 * query-text opt-in off must stop and delete saved tab drafts immediately,
 * not at the next launch. */
export function registerPreferencesIpcHandlers(store: PreferencesStore): void {
  ipcMain.handle('preferences:get', (): Preferences => store.get())
  ipcMain.handle('preferences:update', (_event, patch: Partial<Preferences>): Preferences => {
    const updated = store.update(patch)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('preferences:updated', updated)
    }
    return updated
  })
}
