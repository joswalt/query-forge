import { ipcMain } from 'electron'
import type { Preferences, PreferencesStore } from '../local-storage/preferences-store'

/** Registers the Preferences read/update surface (e.g. user story 53's
 * query-history-text opt-in, user story 54's theme choice). */
export function registerPreferencesIpcHandlers(store: PreferencesStore): void {
  ipcMain.handle('preferences:get', (): Preferences => store.get())
  ipcMain.handle(
    'preferences:update',
    (_event, patch: Partial<Preferences>): Preferences => store.update(patch)
  )
}
