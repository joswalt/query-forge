import { defineConfig } from '@playwright/test'

/**
 * Playwright's Electron support (spec.md Testing Decisions) — the layer
 * that covers what plain-Node Vitest structurally cannot: anything that is
 * main-process-only by construction (`safeStorage`, ADR 0001) or spans the
 * real main↔utilityProcess `MessagePort` handoff. Kept in its own
 * `electron-tests/` directory with its own Playwright config rather than
 * living under `src/` with the Vitest suite — the two runners have
 * different lifecycles (Vitest: plain Node, fast, many files; Playwright
 * here: one real Electron process per test file, slow, few files) and
 * `vitest.config.ts`'s `include` globs already only look under `src/`.
 *
 * Prerequisites (see README.md in this directory) — neither is automated by
 * this config, since both are slow, environment-dependent steps a CI-less,
 * local-only project (spec.md: "CI pipeline: explicitly deferred") runs by
 * hand before this suite:
 *   1. `npm run build` — these tests launch the real built app
 *      (`out/main/index.js`), not source directly.
 *   2. `npm run rebuild:electron` — `better-sqlite3` is Node-ABI by default
 *      (vitest.config.ts runs plain Node); the real Electron process these
 *      tests launch needs the Electron-ABI build or the app fails at
 *      `app.whenReady()` before a window ever opens.
 */
export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
