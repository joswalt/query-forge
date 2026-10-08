# QueryForge

Cross-platform desktop database query and exploration tool for Azure Cosmos DB for NoSQL and Azure SQL Database. See `.docs/product-overview.md` for the product spec and `.scratch/queryforge-architecture/spec.md` for the locked implementation spec this codebase follows.

## Stack

Electron + React + TypeScript, built with [electron-vite](https://electron-vite.org). See `GLOSSARY.md` for domain vocabulary and `docs/adr/` for architecture decision records.

## Setup

```sh
npm install
```

`better-sqlite3` is a native module compiled against Node's ABI by default — fine for `npm test`, but the real Electron app needs an Electron-ABI rebuild first:

```sh
npm run rebuild:electron
```

Run this once after `npm install`, and again after any `better-sqlite3` or Electron version bump, before `npm run dev` or `npm run build`.

> **Note:** `package.json` pins `rollup` to `4.64.1` via `overrides`. This works around the internal npm registry mirror lagging behind the public registry for `@rollup/rollup-darwin-arm64`'s newer versions (`ETARGET` on install otherwise). Safe to remove once the mirror catches up — check by bumping the override and running `npm install`.

## Scripts

- `npm run dev` — launch the app in development mode (hot reload).
- `npm run build` — build main/preload/renderer bundles to `out/`.
- `npm run typecheck` — typecheck main+preload and renderer separately.
- `npm test` — run the Vitest unit suite (plain-Node seam: Database Provider Interface, application services).
- `npm run rebuild:electron` — rebuild native modules (`better-sqlite3`) against Electron's ABI.

## Testing strategy

Per the implementation spec's Testing Decisions (mirroring map.md ticket 11), tests split three ways:

1. **Plain-Node unit tests (Vitest, this repo today):** the Database Provider Interface and its implementations (`CosmosDbProvider`, `AzureSqlProvider`, each tested against an injected fake SDK client rather than a mock of the real SDK), the `QueryExecutionService` request router, the Local Storage Service, the Connection Manager (with `SecretStore` mocked), and the renderer's `queryRunReducer` (`src/renderer/src/query-tabs/`, a pure state machine with no CodeMirror/IPC/React dependency) — none need a real Electron runtime or jsdom.
2. **Electron-runtime integration tests (Playwright's Electron support, not yet set up):** `SafeStorageSecretStore`'s real `safeStorage` round-trip; the main↔utility `MessagePort` Decrypted Secret handoff (`QueryExecutionClient` ↔ `utility-entry.ts`, confirmed as a seam deferred to this layer rather than Vitest — see `src/main/query-execution/query-execution-client.ts`'s class doc); the query editor/execution/cancellation renderer UI (CodeMirror, tab switching, the `query:execute`/`query:cancel` IPC streaming path).
3. **Provider integration tests (not yet set up):** Cosmos DB Provider against the vNext emulator (via `testcontainers`) and a free-tier account; Azure SQL Provider against a free-tier Azure SQL Database.

## Status

Phase 3 slice (on top of Phase 1's application shell/Local Storage Service/Connection Manager and Phase 2's Database Provider Interface + both Providers + connection testing/metadata): the query editor, query execution, and cancellation are now wired end-to-end into the renderer.

- **Query editor** (`src/renderer/src/editor/`): CodeMirror 6, assembled from individual `@codemirror/*` extensions rather than the `codemirror` meta-package's `basicSetup` — `basicSetup` bundles `autocompletion()`, and ticket 04 locked autocomplete (including keyword autocomplete) as out of scope for MVP. Covers user story 18's list (syntax highlighting via a Cosmos NoSQL `SQLDialect` + `@codemirror/lang-sql`'s built-in `MSSQL` dialect, automatic indentation, bracket matching, line numbers, find/replace, undo/redo). `Mod-Enter` (⌘/Ctrl+Enter) runs the current selection, or the whole document if nothing is selected (user stories 24-25).
- **Query tabs** (`src/renderer/src/query-tabs/QueryWorkspace.tsx`): multiple independent tabs, each with its own connection selection, retained query text, and execution state, so one tab's slow/stuck query never blocks another (user stories 21-22, 29).
- **Execution state** (`query-run-reducer.ts`): a pure, Vitest-unit-tested reducer (no jsdom needed) tracking status/rows/row count/RU total/duration per run — the TDD seam for this slice.
- **Streamed execution over IPC** (`query:start`/`query:execute`/`query:cancel` in `query-execution-ipc.ts`, `queryStreamApi` in preload): `ipcRenderer.invoke` can't model a multi-chunk stream, so `query:execute` uses `send` plus a per-Execution-ID pair of `query:chunk:*`/`query:done:*`/`query:error:*` channels instead. The Execution ID itself is minted by main (`query:start`, via `node:crypto`'s `randomUUID`), not the renderer — GLOSSARY.md assigns that responsibility to the Query Execution Service side of the boundary; `queryStreamApi.execute` awaits the mint and attaches its listeners before `query:execute` is ever sent, so streaming can't start before the renderer is listening.
- **Cancel vs. error distinction**: both Providers' asymmetric `cancel()` surfaces as the async iterator throwing (identically to a genuine failure) by the time it reaches the renderer — `QueryWorkspace` tracks whether *it* called cancel and tells the reducer, so a user-requested cancel renders as "Cancelled," not an error (user stories 26, 30).
- **Results display is intentionally minimal** (`QueryResultsView.tsx`): a plain, capped (`MAX_DISPLAY_ROWS = 1000`) HTML table with NULL-value display, row count, duration, and RU — proving the vertical slice, not the real grid. The TanStack Table/Virtual grid with clipboard copy, JSON view, and resizable columns (user stories 38-43) is later "results/export" phase work per spec.md's build order.

Known gaps/decisions carried forward explicitly (not oversights):

- **Entra ID auth is not implemented** on either Provider — both throw a typed `UnsupportedAuthModeError` for `entra-id`; only `account-key` / `sql-credentials` work today. The interactive `msal-node` PKCE flow is a separate, later Connection Manager slice.
- **`QueryExecutionClient` (the main-side utilityProcess fork/correlation wrapper) is not unit-tested** — confirmed seam, left for a Playwright-Electron integration test later; `QueryExecutionService`, the part of it that *is* plain-Node-testable, has full coverage.
- **The utilityProcess fork target (`utility-entry.ts`) has not been smoke-tested against a real Electron runtime** in this environment (sandboxed; `npm run build` validates the bundler output and that both `out/main/index.js` and `out/main/utility-entry.js` emit correctly, but not the actual `utilityProcess.fork()` + ESM-loading path) — run `npm run dev` locally to confirm before relying on it. This now also applies to the new `query:execute`/`query:cancel` IPC streaming path, for the same reason.
- **Azure SQL's `QueryOptions.timeoutMs` is not a true per-query override** — mssql only exposes timeout at pool-creation time, so it's set once from the profile's `connectionTimeoutMs` at `connect()`.
- **The query-tab connection picker does not filter by live connection status** — selecting a saved-but-not-connected profile surfaces the Query Execution Service's own "No active connection for profile" error on Run, rather than disabling the option up front.

No results grid or export yet — see the implementation spec's suggested build order for what's next (results/export, then history/saved-queries/themes/tests/packaging).
