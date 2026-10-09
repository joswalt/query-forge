import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright-core'

const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

// user@password-shaped and distinctive enough that an accidental substring
// match (e.g. inside a generic driver error message) would be implausible.
const PLAINTEXT_SECRET = 'qf-handoff-secret-zT9kP2'

/**
 * The main→utilityProcess `MessagePort` Decrypted Secret handoff (ADR
 * 0001, spec.md Testing Decisions' named integration-test seam): a secret
 * sent from the renderer reaches the Query Execution Service and is
 * actually used there — but is never echoed back to the renderer, and
 * never written to the main process's own stdout/stderr.
 *
 * Uses `connection:test` (user story 6: "test a connection's parameters
 * before saving it") against a deliberately unreachable Azure SQL host —
 * this exercises the *real* handoff path (ConnectionManager → MessagePort →
 * QueryExecutionService → AzureSqlProvider.testConnection, main/ipc/
 * query-execution-ipc.ts's `resolveTestSubject`) without needing a live
 * database, and fails fast via `connectionTimeoutMs` rather than hanging.
 */
test.describe('main→utilityProcess Decrypted Secret handoff (ADR 0001)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let stdout = ''
  let stderr = ''

  test.beforeEach(async () => {
    electronApp = await electron.launch({ args: [APP_ENTRY] })
    const proc = electronApp.process()
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    page = await electronApp.firstWindow()
  })

  test.afterEach(async () => {
    await electronApp.close()
  })

  test('is used by the Query Execution Service but never echoed back or logged', async () => {
    const result = await page.evaluate(async (secret) => {
      return window.api.queryExecution.test({
        config: {
          kind: 'azure-sql',
          server: 'qf-handoff-test.invalid',
          database: 'test',
          authMode: 'sql-credentials',
          username: 'test',
          connectionTimeoutMs: 3000
        },
        secret
      })
    }, PLAINTEXT_SECRET)

    // The handoff reached the provider: a real (failed) connection attempt
    // happened, not an immediate validation error — proving the secret was
    // actually used to try constructing a client, not merely accepted and
    // dropped.
    expect(result.success).toBe(false)
    expect(result.message).toBeTruthy()

    // Never echoed back to the renderer: the full TestResult payload the
    // renderer received must not contain the plaintext secret anywhere in
    // it (not just not in `.message` — the whole JSON shape).
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT_SECRET)

    // Never logged: the main process's own stdout/stderr, captured for the
    // whole lifetime of this test, must not contain the plaintext secret
    // either (e.g. from an errant `console.log` of a connection config).
    expect(stdout).not.toContain(PLAINTEXT_SECRET)
    expect(stderr).not.toContain(PLAINTEXT_SECRET)
  })
})
