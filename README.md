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
2. **Electron-runtime integration tests (Playwright's Electron support, scaffolded in `electron-tests/` — `npm run test:e2e`; coverage is the `safeStorage` round-trip and secret handoff specs, not yet the renderer UI):** `SafeStorageSecretStore`'s real `safeStorage` round-trip; the main↔utility `MessagePort` Decrypted Secret handoff (`QueryExecutionClient` ↔ `utility-entry.ts`, confirmed as a seam deferred to this layer rather than Vitest — see `src/main/query-execution/query-execution-client.ts`'s class doc); the query editor/execution/cancellation renderer UI (CodeMirror, tab switching, the `query:execute`/`query:cancel` IPC streaming path).
3. **Provider integration tests (not yet set up):** Cosmos DB Provider against the vNext emulator (via `testcontainers`) and a free-tier account; Azure SQL Provider against a free-tier Azure SQL Database.

## Status

All five build phases from `.docs/product-overview.md` §11 have landed in some form. `npm test` (Vitest) and `npm run typecheck` pass and `npm run build` emits main/preload/renderer bundles; nothing below has been exercised against a live Cosmos DB / Azure SQL / Entra ID tenant, and the Electron-runtime paths (utilityProcess fork, IPC streaming, native dialogs) still need a manual `npm run dev` smoke test.

Implemented:

- **Connections** — create/edit/delete/test/connect/disconnect, groups (`group_name`), recent connections (`last_connected_at`), read-only flag, per-connection timeout, Cosmos database/container. Secrets are `safeStorage` ciphertext in SQLite (ADR 0001); Entra ID via `msal-node` interactive PKCE with a self-rolled cache plugin.
- **Read-only enforcement** (`query-execution/read-only-guard.ts`) — checked inside the Query Execution Service. Azure SQL: best-effort keyword scan (comments/strings/bracketed identifiers stripped) rejecting DML/DDL/`EXEC`/`SELECT … INTO`. This is an accident guard, **not a security boundary** — use a read-only database login for that. Cosmos NoSQL queries cannot mutate, so they are not inspected.
- **Object Explorer** — Azure SQL schemas/tables/views/columns (with data type and primary-key flag)/indexes; Cosmos databases → containers → partition keys. Refresh re-reads metadata; double-clicking a table/view/container opens a prefilled `SELECT TOP 100` tab (Cosmos tabs carry `QueryOptions.database/container`).
- **Resizable panels** (story 54) — sidebar width and editor/results split (drag, arrow keys, double-click to reset), both remembered across launches.
- **Query editor/tabs** — CodeMirror 6 (no autocomplete, per ticket 04), independent tabs, streamed execution, cancel, `Cmd/Ctrl+Enter`, open/save query files via native dialogs, and unsaved-tab drafts restored after a crash (renderer `localStorage`, debounced; **only when the query-history text opt-in is enabled**, since drafts hold query text — user story 53).
- **Results** — virtualized TanStack grid, JSON view, cell inspector, CSV/JSON export (loaded rows or all matching rows with progress/cancel).
- **Reliability** — Cosmos 429 retry policy stated explicitly (`COSMOS_RETRY_OPTIONS`); if the utilityProcess dies, all in-flight calls reject with a "disconnect and reconnect" message and the next call forks a fresh child.
- **History, saved queries, preferences/theme** — SQLite-backed; history text is opt-in (user story 53).
- **Packaging/tests** — `electron-builder` unsigned config; Playwright Electron scaffolding in `electron-tests/`.

Known gaps/decisions carried forward explicitly (not oversights):

- **Query formatting** (story 20) uses `sql-formatter` (MIT): T-SQL for Azure SQL, BigQuery's dialect for Cosmos NoSQL (the only one that parses `@param`/`c["key"]`; `VALUE` keeps its typed case). Formats the selection or whole editor as one undoable edit; unparseable text is left unchanged.
- **Multi-statement SQL** (story 61) streams all recordsets' rows through one result stream; per-statement result sets are not separated.
- **Azure SQL's `QueryOptions.timeoutMs` is not a per-query override** — mssql only exposes timeout at pool creation, so the profile's timeout field sets both connect and query (`requestTimeout`) timeouts; unset defaults to 60s query timeout (mssql's own default is 15s). Cosmos maps the same field to `connectionPolicy.requestTimeout`.
- **Editing a connected profile disconnects it** — the Query Execution Service keeps the profile as of `connect()`, so edits (including read-only) apply on reconnect.
- **No mid-session Entra ID token refresh** — the token is handed over once per `connect()` (ADR 0001); an expired token surfaces a "disconnect and reconnect" message.
- **After a utilityProcess crash the UI may still show a profile as "connected"** until the next call fails; reconnect to recover.
- **`QueryExecutionClient` and `utility-entry.ts` are not unit-tested** — a seam deferred to the Playwright-Electron layer.
- **Provider integration tests** against the Cosmos emulator / free-tier Azure SQL are not set up; CI is deferred per spec.
