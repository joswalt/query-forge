# Decrypt credentials in main, hand plaintext to the Query Execution Service once per connect

Electron's `safeStorage` API is main-process-only — it is not reachable from a `utilityProcess.fork()`-spawned process (confirmed via Electron's docs and maintainer-closed feature request electron/electron#42869). Since query execution and connection pooling live in a shared `utilityProcess` (ticket 06), the Connection Manager (main) decrypts a Secret Ciphertext into a Decrypted Secret and hands it once, at connect-time, to the Query Execution Service over the main↔utility `MessagePort`. The Decrypted Secret is never persisted or re-transmitted beyond that single handoff.

**Considered and rejected**: keeping Secret Ciphertext decryption and the live database connection both in main would have been simpler, but defeats the entire reason query execution was isolated into a `utilityProcess` — crash containment for code executing arbitrary user-written queries against two different database engines.

**Consequence**: a Decrypted Secret briefly transits an internal, trusted IPC channel once per connection (not per query). This is not an Electron-documented pattern — it's the de facto workaround used elsewhere for this same platform gap — so a future reader re-examining Connection Manager/Query Execution Service IPC code should not assume plaintext-over-IPC here is an oversight.
