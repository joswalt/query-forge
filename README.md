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

1. **Plain-Node unit tests (Vitest, this repo today):** the Database Provider Interface and its implementations, the Local Storage Service, and the Connection Manager (with `SecretStore` mocked) — none need a real Electron runtime.
2. **Electron-runtime integration tests (Playwright's Electron support, not yet set up):** `SafeStorageSecretStore`'s real `safeStorage` round-trip, and the main↔utility `MessagePort` Decrypted Secret handoff once the Query Execution Service exists.
3. **Provider integration tests (not yet set up):** Cosmos DB Provider against the vNext emulator (via `testcontainers`) and a free-tier account; Azure SQL Provider against a free-tier Azure SQL Database.

## Status

Phase 1 slice only: application shell, Local Storage Service (SQLite + hand-rolled migrations), and Connection Manager (Connection Profile CRUD + secret encrypt/decrypt) wired end-to-end through IPC to a minimal renderer. No Database Provider implementations, query editor, results grid, or export yet — see the implementation spec's suggested build order for what's next.
