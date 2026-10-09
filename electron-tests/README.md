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

Written against the locked spec/ADR but **not run** in the environment this
code was authored in — launching the real Electron binary there silently
falls back to plain Node (`require('electron')` fails inside the launched
process), independent of sandboxing. Confirm these pass on a machine where
`npm run dev` opens a real window before relying on them.

## Known limitations (spec.md Testing Decisions)

Playwright's Electron support is labeled "experimental" by Playwright
itself. If a test here becomes flaky, check that first before assuming a
product regression.
