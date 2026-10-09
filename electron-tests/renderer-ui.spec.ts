import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright-core'

const APP_ENTRY = join(import.meta.dirname, '..', 'out', 'main', 'index.js')

/**
 * Renderer E2E that needs no live database: tab state (user stories 21-22),
 * the no-connection error path (30), and theme switching (54). CodeMirror 6
 * is a `contenteditable` surface, so text goes in via `pressSequentially`,
 * not `fill()` (spec.md Testing Decisions' known limitation).
 *
 * Each test launches against a throwaway `--user-data-dir` so it never reads
 * or writes the developer's real QueryForge profile (SQLite, preferences,
 * localStorage drafts).
 */
test.describe('renderer UI (no database required)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'queryforge-e2e-'))
    electronApp = await electron.launch({ args: [APP_ENTRY, `--user-data-dir=${userDataDir}`] })
    page = await electronApp.firstWindow()
    await page.locator('.cm-content').first().waitFor()
  })

  test.afterEach(async () => {
    await electronApp.close()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  const editor = (): ReturnType<Page['locator']> => page.locator('.cm-content').first()
  const tab = (title: string): ReturnType<Page['getByRole']> =>
    page.getByRole('tab', { name: title, exact: true })

  test('retains each tab’s query text when switching tabs (story 22)', async () => {
    await editor().click()
    await editor().pressSequentially('SELECT 1')

    await page.getByRole('button', { name: 'New tab' }).click()
    await expect(tab('Query 2')).toHaveAttribute('aria-selected', 'true')
    await expect(editor()).not.toContainText('SELECT 1')
    await editor().click()
    await editor().pressSequentially('SELECT 2')

    await tab('Query 1').click()
    await expect(editor()).toContainText('SELECT 1')
    await expect(editor()).not.toContainText('SELECT 2')

    await tab('Query 2').click()
    await expect(editor()).toContainText('SELECT 2')
  })

  test('running without a connection shows an error and keeps the query text (story 30)', async () => {
    await editor().click()
    await editor().pressSequentially('SELECT 1')

    await page.getByRole('button', { name: /^Run/ }).click()

    await expect(page.locator('.query-results__status')).toHaveAttribute('data-status', 'error')
    await expect(page.getByText('Select a connection before running a query.')).toBeVisible()
    await expect(editor()).toContainText('SELECT 1')
  })

  test('fills the connection form from an Azure SQL service principal string', async () => {
    const toggle = page.getByRole('button', { name: /New connection/ })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()

    await page.getByText('Fill from a connection string').click()
    await page
      .getByLabel('ADO.NET connection string')
      .fill(
        'Server=tcp:h.database.windows.net,1433;Initial Catalog=stg;Encrypt=True;Authentication="Active Directory Service Principal";User ID=11111111-2222-3333-4444-555555555555;Password=s3cret'
      )
    await page.getByRole('button', { name: 'Fill fields' }).click()

    await expect(page.getByLabel('Server hostname')).toHaveValue('h.database.windows.net')
    await expect(page.getByLabel('Database name')).toHaveValue('stg')
    await expect(page.getByLabel('Authentication')).toHaveValue('service-principal')
    await expect(page.getByLabel('Client ID')).toHaveValue('11111111-2222-3333-4444-555555555555')
    await expect(page.getByLabel('Client secret')).toHaveValue('s3cret')
    // The raw string (which held the secret) is gone, and the user is told what's left to fill.
    await expect(page.getByLabel('ADO.NET connection string')).toBeHidden()
    await expect(page.getByText('Enter the Tenant ID')).toBeVisible()
  })

  test('toggles the theme and persists it across relaunch (story 54)', async () => {
    const html = page.locator('html')
    const before = await html.getAttribute('data-theme')
    expect(['dark', 'light']).toContain(before)
    const expected = before === 'dark' ? 'light' : 'dark'

    await page.locator('.theme-toggle').click()
    await expect(html).toHaveAttribute('data-theme', expected)

    await electronApp.close()
    electronApp = await electron.launch({ args: [APP_ENTRY, `--user-data-dir=${userDataDir}`] })
    page = await electronApp.firstWindow()
    await expect(page.locator('html')).toHaveAttribute('data-theme', expected)
  })
})
