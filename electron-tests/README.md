# Electron integration tests (Playwright)

Covers the two seams spec.md's Testing Decisions names as needing a real
Electron runtime, not plain-Node Vitest:

- `safe-storage.spec.ts` — `safeStorage` encrypt/decrypt round-trip
  (main-process-only by construction, ADR 0001), plus the ciphertext
  surviving a real `better-sqlite3` BLOB round-trip.
- `secret-handoff.spec.ts` — the main→utilityProcess `MessagePort`
  Decrypted Secret handoff: confirms a secret sent via `connection:test`
  reaches the Query Execution Service (it's used to attempt a real
  connection attempt) and is never echoed back to the renderer or written
  to the main process's own stdout/stderr.

## Running

```sh
npm run build            # bundles the real app into out/
npm run rebuild:electron  # better-sqlite3: Node-ABI -> Electron-ABI
npm run test:e2e
```

## Known status

All specs pass on macOS (`npm run test:e2e`, Electron 44). One environment gotcha:
if your shell exports `ELECTRON_RUN_AS_NODE=1` (some agent/IDE shells do), the
launched binary runs as plain Node and fails with `bad option:
--remote-debugging-port=0`. Run `env -u ELECTRON_RUN_AS_NODE npm run test:e2e`.

`renderer-ui.spec.ts` launches with a throwaway `--user-data-dir`, so it never
touches your real QueryForge profile.
