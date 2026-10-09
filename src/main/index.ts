import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { openDatabase } from './local-storage/open-database'
import { ConnectionProfileRepository } from './local-storage/connection-profile-repository'
import { QueryHistoryRepository } from './local-storage/query-history-repository'
import { SavedQueryRepository } from './local-storage/saved-query-repository'
import { MsalTokenCacheRepository } from './local-storage/msal-token-cache-repository'
import { PreferencesStore } from './local-storage/preferences-store'
import { ConnectionManager } from './connection-manager/connection-manager'
import { SafeStorageSecretStore } from './connection-manager/safe-storage-secret-store'
import { MsalEntraIdAuthenticator } from './connection-manager/entra-id-authenticator'
import { SqliteTokenCacheStore } from './connection-manager/sqlite-token-cache-store'
import { registerConnectionIpcHandlers } from './ipc/connection-ipc'
import { registerQueryExecutionIpcHandlers } from './ipc/query-execution-ipc'
import { registerExportIpcHandlers } from './ipc/export-ipc'
import { registerFileIpcHandlers } from './ipc/file-ipc'
import { registerHistoryIpcHandlers } from './ipc/history-ipc'
import { registerPreferencesIpcHandlers } from './ipc/preferences-ipc'
import { registerSavedQueryIpcHandlers } from './ipc/saved-query-ipc'
import { QueryExecutionClient } from './query-execution/query-execution-client'
import { ExportService } from './export/export-service'

/**
 * Both the Connection Manager and Query History Entry persistence live in
 * the same SQLite database (Local Storage Service, map.md ticket 07) — one
 * `openDatabase` call, shared across repositories, rather than one
 * connection per repository.
 */
function createLocalStorage(): {
  connectionManager: ConnectionManager
  historyRepository: QueryHistoryRepository
  savedQueryRepository: SavedQueryRepository
  preferencesStore: PreferencesStore
} {
  const dbPath = join(app.getPath('userData'), 'queryforge.db')
  const db = openDatabase(dbPath)
  const secretStore = new SafeStorageSecretStore()
  const tokenCacheRepository = new MsalTokenCacheRepository(db)
  const authenticator = new MsalEntraIdAuthenticator(
    (profileId) => new SqliteTokenCacheStore(tokenCacheRepository, secretStore, profileId),
    (url) => shell.openExternal(url)
  )
  const connectionManager = new ConnectionManager(
    new ConnectionProfileRepository(db),
    secretStore,
    authenticator,
    tokenCacheRepository
  )
  const historyRepository = new QueryHistoryRepository(db)
  const savedQueryRepository = new SavedQueryRepository(db)
  const preferencesStore = new PreferencesStore(join(app.getPath('userData'), 'preferences.json'))
  return { connectionManager, historyRepository, savedQueryRepository, preferencesStore }
}

function createQueryExecutionClient(): QueryExecutionClient {
  // Sibling output file to this one (electron.vite.config.ts's `main`
  // target builds both as separate rollup inputs) — the utilityProcess
  // fork target for the Query Execution Service (ADR 0001).
  const utilityModulePath = join(__dirname, 'utility-entry.js')
  return new QueryExecutionClient(utilityModulePath)
}

/** Packaged builds take their icon from electron-builder (resources/icon.icns
 * / icon.ico). Unpackaged runs (`npm run dev`) would otherwise show
 * Electron's default icon in the Dock and the Cmd-Tab app switcher. */
const devIconPath = join(__dirname, '../../resources/icon.png')

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(app.isPackaged ? {} : { icon: devIconPath }),
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
  if (!app.isPackaged) app.dock?.setIcon(devIconPath)
  const { connectionManager, historyRepository, savedQueryRepository, preferencesStore } =
    createLocalStorage()
  queryExecutionClient = createQueryExecutionClient()
  // Story 63: the fresh child forked on the next call has no live providers,
  // so tell every window its "connected" statuses are stale.
  queryExecutionClient.onUnexpectedExit(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('query-execution:service-exited')
    }
  })
  registerConnectionIpcHandlers(connectionManager)
  registerQueryExecutionIpcHandlers(
    connectionManager,
    queryExecutionClient,
    historyRepository,
    preferencesStore
  )
  registerExportIpcHandlers(new ExportService(queryExecutionClient), queryExecutionClient)
  registerHistoryIpcHandlers(historyRepository)
  registerPreferencesIpcHandlers(preferencesStore)
  registerSavedQueryIpcHandlers(savedQueryRepository)
  registerFileIpcHandlers()
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
