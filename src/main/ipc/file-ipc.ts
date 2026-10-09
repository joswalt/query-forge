import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

export interface OpenedQueryFile {
  path: string
  name: string
  content: string
}

const QUERY_FILE_FILTERS = [
  { name: 'Query files', extensions: ['sql', 'json', 'txt'] },
  { name: 'All files', extensions: ['*'] }
]

/**
 * Save/open query files via main-side dialogs (user story 23) — the renderer
 * never gets a filesystem path it chose itself, only what the user picked in
 * a native dialog, and never touches `fs` directly (§6).
 */
export function registerFileIpcHandlers(): void {
  ipcMain.handle(
    'file:saveQuery',
    async (event, defaultName: string, content: string): Promise<string | undefined> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = { defaultPath: defaultName, filters: QUERY_FILE_FILTERS }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return undefined
      await writeFile(result.filePath, content, 'utf8')
      return result.filePath
    }
  )

  ipcMain.handle('file:openQuery', async (event): Promise<OpenedQueryFile | undefined> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ['openFile' as const], filters: QUERY_FILE_FILTERS }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return undefined
    return { path, name: basename(path), content: await readFile(path, 'utf8') }
  })
}
