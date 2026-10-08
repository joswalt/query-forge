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

1. **Plain-Node unit tests (Vitest, this repo today):** the Database Provider Interface and its implementations (`CosmosDbProvider`, `AzureSqlProvider`, each tested against an injected fake SDK client rather than a mock of the real SDK), the `QueryExecutionService` request router, the Local Storage Service, and the Connection Manager (with `SecretStore` mocked) — none need a real Electron runtime.
2. **Electron-runtime integration tests (Playwright's Electron support, not yet set up):** `SafeStorageSecretStore`'s real `safeStorage` round-trip; the main↔utility `MessagePort` Decrypted Secret handoff (`QueryExecutionClient` ↔ `utility-entry.ts`, confirmed as a seam deferred to this layer rather than Vitest — see `src/main/query-execution/query-execution-client.ts`'s class doc).
3. **Provider integration tests (not yet set up):** Cosmos DB Provider against the vNext emulator (via `testcontainers`) and a free-tier account; Azure SQL Provider against a free-tier Azure SQL Database.

## Status

Phase 2 slice (on top of Phase 1's application shell, Local Storage Service, and Connection Manager): the Database Provider Interface now has both implementations —`CosmosDbProvider` (`@azure/cosmos`) and `AzureSqlProvider` (`mssql`) — running inside a Query Execution Service that lives in a shared Electron `utilityProcess` (`src/main/query-execution/`), reached from main via a correlation-id protocol (`protocol.ts`) over the main↔utility `MessagePort` (ADR 0001). Connection testing, connect/disconnect, and initial metadata discovery are wired end-to-end through new `connection:test` / `connection:connect` / `connection:disconnect` / `connection:getMetadata` IPC channels, with a minimal renderer UI (status per connection, a metadata list) proving the vertical slice.

Known gaps/decisions carried forward explicitly (not oversights):

- **Entra ID auth is not implemented** on either Provider — both throw a typed `UnsupportedAuthModeError` for `entra-id`; only `account-key` / `sql-credentials` work today. The interactive `msal-node` PKCE flow is a separate, later Connection Manager slice.
- **`QueryExecutionClient` (the main-side utilityProcess fork/correlation wrapper) is not unit-tested** — confirmed seam, left for a Playwright-Electron integration test later; `QueryExecutionService`, the part of it that *is* plain-Node-testable, has full coverage.
- **The utilityProcess fork target (`utility-entry.ts`) has not been smoke-tested against a real Electron runtime** in this environment (sandboxed; `npm run build` validates the bundler output and that both `out/main/index.js` and `out/main/utility-entry.js` emit correctly, but not the actual `utilityProcess.fork()` + ESM-loading path) — run `npm run dev` locally to confirm before relying on it.
- **Azure SQL's `QueryOptions.timeoutMs` is not a true per-query override** — mssql only exposes timeout at pool-creation time, so it's set once from the profile's `connectionTimeoutMs` at `connect()`.
- Query execution (`executeQuery`/`cancel`) is implemented and unit-tested at the Provider and `QueryExecutionService` layers, but not yet wired into renderer UI (query editor, cancel button) — that's Phase 3 (product-overview.md §11).

No query editor, results grid, or export yet — see the implementation spec's suggested build order for what's next.
