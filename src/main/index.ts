import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './local-storage/open-database'
import { ConnectionProfileRepository } from './local-storage/connection-profile-repository'
import { ConnectionManager } from './connection-manager/connection-manager'
import { SafeStorageSecretStore } from './connection-manager/safe-storage-secret-store'
import { registerConnectionIpcHandlers } from './ipc/connection-ipc'
import { registerQueryExecutionIpcHandlers } from './ipc/query-execution-ipc'
import { QueryExecutionClient } from './query-execution/query-execution-client'

function createConnectionManager(): ConnectionManager {
  const dbPath = join(app.getPath('userData'), 'queryforge.db')
  const db = openDatabase(dbPath)
  const repository = new ConnectionProfileRepository(db)
  const secretStore = new SafeStorageSecretStore()
  return new ConnectionManager(repository, secretStore)
}

function createQueryExecutionClient(): QueryExecutionClient {
  // Sibling output file to this one (electron.vite.config.ts's `main`
  // target builds both as separate rollup inputs) — the utilityProcess
  // fork target for the Query Execution Service (ADR 0001).
  const utilityModulePath = join(__dirname, 'utility-entry.js')
  return new QueryExecutionClient(utilityModulePath)
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // Open external links in the OS browser rather than a new BrowserWindow
  // (Entra ID's interactive auth also uses the system browser — see
  // docs/adr/0001-... for the related credential-handoff design).
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let queryExecutionClient: QueryExecutionClient | undefined

app.whenReady().then(() => {
  const connectionManager = createConnectionManager()
  queryExecutionClient = createQueryExecutionClient()
  registerConnectionIpcHandlers(connectionManager)
  registerQueryExecutionIpcHandlers(connectionManager, queryExecutionClient)
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Terminate the shared Query Execution Service utilityProcess alongside
// the app — it does not exit on its own when all windows close.
app.on('before-quit', () => {
  queryExecutionClient?.shutdown()
})
