import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright-core'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/**
 * `safeStorage` (ADR 0001) is reachable only from Electron's main process —
 * this is the one seam in spec.md's Testing Decisions that plain-Node
 * Vitest structurally cannot exercise (`SafeStorageSecretStore`'s own doc
 * comment says as much). `electronApp.evaluate()` runs the given function
 * *inside* the launched app's main process, so it can call the real
 * `safeStorage` API directly — no IPC plumbing of our own required to
 * reach it.
 */
test.describe('safeStorage round-trip (ADR 0001)', () => {
  let electronApp: ElectronApplication

  test.beforeEach(async () => {
    electronApp = await electron.launch({ args: [APP_ENTRY] })
    // The real app's first window creation also boots its SQLite-backed
    // Local Storage Service (main/index.ts's `app.whenReady` handler) —
    // waiting for it confirms the Electron-ABI `better-sqlite3` rebuild
    // (this file's prerequisite) actually succeeded, not just that
    // `safeStorage` happens to work.
    await electronApp.firstWindow()
  })

  test.afterEach(async () => {
    await electronApp.close()
  })

  test('encrypts and decrypts a secret back to its original plaintext', async () => {
    const plaintext = 'correct-horse-battery-staple'

    const decrypted = await electronApp.evaluate(({ safeStorage }, secret) => {
      const ciphertext = safeStorage.encryptString(secret)
      return safeStorage.decryptString(ciphertext)
    }, plaintext)

    expect(decrypted).toBe(plaintext)
  })

  test('produces ciphertext that is not the plaintext itself', async () => {
    const plaintext = 'correct-horse-battery-staple'

    const ciphertextIsDifferent = await electronApp.evaluate(({ safeStorage }, secret) => {
      const ciphertext = safeStorage.encryptString(secret)
      return ciphertext.toString('utf8') !== secret && ciphertext.length > 0
    }, plaintext)

    expect(ciphertextIsDifferent).toBe(true)
  })

  /**
   * Extends the round-trip through a real `better-sqlite3` BLOB column —
   * the actual persisted shape (Connection Profile's `secret_ciphertext`
   * column, connection-profile-repository.ts), not just an in-memory
   * Buffer. Requires the Electron-ABI rebuild (this file's prerequisite);
   * if `better-sqlite3`'s native addon was never rebuilt for Electron's
   * Node ABI, this call throws instead of asserting false — the
   * instruction to run `npm run rebuild:electron` is the fix, not a code
   * change here.
   */
  test('survives a round-trip through a better-sqlite3 BLOB column', async () => {
    const plaintext = 'correct-horse-battery-staple'

    const decrypted = await electronApp.evaluate(({ safeStorage }, secret) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3')
      const db = new Database(':memory:')
      db.exec('CREATE TABLE secrets (ciphertext BLOB NOT NULL)')

      const ciphertext = safeStorage.encryptString(secret)
      db.prepare('INSERT INTO secrets (ciphertext) VALUES (?)').run(ciphertext)

      const row = db.prepare('SELECT ciphertext FROM secrets').get() as {
        ciphertext: Buffer
      }
      return safeStorage.decryptString(row.ciphertext)
    }, plaintext)

    expect(decrypted).toBe(plaintext)
  })
})
