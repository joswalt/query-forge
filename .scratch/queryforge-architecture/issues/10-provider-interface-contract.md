Type: grilling
Blocked by: 02, 06, 08
Status: resolved

## Question

Lock the Database Provider Interface contract and the §6 component/module boundaries (Desktop Application Shell, User Interface, Connection Manager, Query Execution Service, Database Provider Interface, Cosmos DB Provider, Azure SQL Provider, Local Storage Service, Export Service), given the desktop framework (ticket 02) and driver strategy (ticket 06) decisions.

Per §7, the interface must not assume all databases support identical query languages, pagination strategies, result structures, or transaction semantics — design it to be provider-agnostic in principle, but do not design concrete future providers (Postgres/MySQL/SQLite/MongoDB stay out of scope for this map).

Define: the contract's method surface (connect, test, execute, cancel, paginate/continuation handling, metadata discovery); how Cosmos DB's RU/continuation-token model and Azure SQL's tabular/timeout model both fit without leaking provider-specific details into the UI layer; and where each §6 component's responsibility boundary sits.

**Flag from ticket 04 (Query Editor):** CodeMirror 6 was chosen with autocomplete explicitly out of scope for MVP — there is no completion-provider consumer wired up on the editor side. Don't design this interface's metadata-discovery surface assuming a live autocomplete consumer exists; metadata discovery (tables/containers/columns) is still needed for the Object Explorer (§4.2), just not for editor-side completion.

**Flags from ticket 06 (Driver Strategy / Query-Execution Process Model):**
- Providers execute inside a single shared Electron `utilityProcess` (not per-tab, not in main). The interface and its implementations are designed to live there — connection pooling is keyed by connection profile, not by tab, specifically to avoid fragmenting `mssql`'s per-`ConnectionPool` pooling across tabs.
- Cancellation is asymmetric between providers and the interface's `cancel()` contract must not paper over this: Azure SQL's cancellation is genuine server-side (TDS Attention packet via `Request.cancel()`); Cosmos DB's is client-side abandonment only via `AbortSignal` (RU charges already incurred stand, request may complete server-side regardless). Surface this distinction rather than assuming both providers cancel identically.
- Large result-set handling must support pagination/streaming at the interface level — this is not optional plumbing, since it's the only fix for renderer-side JSON-deserialization freeze (process isolation on the execution side does not address that failure mode).

**Flag from ticket 08 (Auth / Credential Storage) — supersedes ticket 07's earlier framing:** all secrets (SQL credentials, Cosmos account keys, MSAL token cache) are encrypted via `safeStorage` and persisted as ciphertext *in SQLite itself*, not in a separate named OS-keychain entry. The only thing actually held by the OS is `safeStorage`'s single app-level master encryption key, managed invisibly by Electron/the OS. Design the Connection Manager's persistence boundary as "SQLite holds metadata + ciphertext; the OS holds one opaque master key" — not "SQLite holds metadata; the OS holds named per-connection secrets." Also: Entra ID auth uses `msal-node`'s `acquireTokenInteractive` (system browser + loopback redirect) with a self-rolled `ICachePlugin` — the Connection Manager (or a dedicated auth module) owns wiring that plugin, not a third-party persistence package.

## Answer

**A real contradiction surfaced between tickets 06 and 08 and was resolved before the contract could be locked:** `safeStorage` is Electron main-process-only (confirmed via Electron's own docs — `Process: Main` designator — and a maintainer-closed "not planned" feature request, electron/electron#42869, asking for utility-process support). It cannot be called from the shared `utilityProcess` ticket 06 put query execution in. Resolution: **main decrypts the credential at connect-time and hands the plaintext to the utilityProcess once, over the existing main↔utility `MessagePort` channel; the utilityProcess uses it immediately to construct the DB client and never persists or re-transmits it.** This is the de facto pattern other Electron projects use for this exact gap. Tradeoff accepted: a brief plaintext transit over an internal, trusted process channel, once per connection (not per query) — not external, not at rest anywhere outside SQLite's ciphertext column. Full research: [`research/10-safestorage-utilityprocess.md`](../research/10-safestorage-utilityprocess.md).

This fixes the Connection Manager's process boundary: **Connection Manager lives entirely in main** (profile CRUD against SQLite, `safeStorage` encrypt/decrypt, the Entra ID `acquireTokenInteractive` + self-rolled `ICachePlugin` flow) and never holds a live DB connection. The **Query Execution Service** (the shared `utilityProcess` from ticket 06) receives an already-decrypted credential once per connect and owns the live provider instances/connection pools from then on.

**§6 component boundaries, locked:**
- **Desktop Application Shell** (main): window/app lifecycle, IPC routing.
- **Connection Manager** (main): connection-profile CRUD in SQLite, `safeStorage` encrypt/decrypt, Entra ID auth flow. No live DB connections. **Refined by ticket 11:** `safeStorage` access is wrapped behind a thin `SecretStore` interface so Connection Manager business logic can be unit-tested with a mock, reserving the real `safeStorage` binding for a small set of Electron-runtime integration tests.
- **Query Execution Service** (shared `utilityProcess`): receives a decrypted credential once at connect-time via `MessagePort`; owns provider instances and connection pools keyed by connection profile (not by tab, per ticket 06); executes queries; handles cancellation; streams results back to main.
- **Database Provider Interface** (implemented inside the Query Execution Service).
- **Cosmos DB Provider / Azure SQL Provider**: concrete implementations of the interface.
- **Local Storage Service** (main): owns the SQLite file + JSON preferences file; Connection Manager is a consumer of it, not identical to it.
- **Export Service** (main): consumes the same result stream the renderer displays and writes to disk — lives in main since it needs filesystem access and main is already the IPC hub, avoiding an extra process hop for large result sets.
- **User Interface** (renderer): CodeMirror editor, TanStack grid, Object Explorer — never touches SQLite, `safeStorage`, or DB drivers directly; everything proxied through `contextBridge` + IPC to main, which routes DB-specific calls to the Query Execution Service.

**Database Provider Interface — method surface, locked:**
```
connect(profile, secret) -> void
testConnection(profile, secret) -> TestResult
disconnect() -> void
executeQuery(query, options) -> AsyncIterable<ResultChunk>   // streaming/paginated, never one big array
cancel(executionId) -> void                                    // asymmetric semantics, documented per provider
getMetadata() -> DatabaseMetadata                              // for Object Explorer (§4.2); not an editor-autocomplete consumer (ticket 04's flag)
```
- `secret` is the plaintext credential handed over from main at connect-time (see above) — the interface never takes ciphertext or touches `safeStorage` itself.
- `executeQuery` returns a streamed/chunked result, directly satisfying ticket 06's pagination/streaming requirement (the only fix for renderer-side JSON-deserialization freeze on large result sets).
- `cancel(executionId)` is explicit about asymmetry in its contract docs: Azure SQL's cancel is genuine server-side (TDS Attention packet via `Request.cancel()`); Cosmos DB's is client-side abandonment only via `AbortSignal` (RU charges already incurred stand; the request may complete server-side regardless). The interface does not pretend both behave identically.
- `ResultChunk` carries rows plus an optional, provider-specific `meta` field (e.g. `{ ru?: number }` for Cosmos; omitted for SQL) — satisfies §4.5's RU-display requirement without forcing every provider's contract to carry a field only one of them produces.
- `getMetadata()` returns tables/columns (SQL) or containers/partition keys (Cosmos) in a shared shape generic enough for the Object Explorer to render without provider-specific branching in the UI layer.

All four flags accumulated on this ticket (04's autocomplete-scope note, 06's process-model/cancellation/streaming notes, 08's credential-custody model) are fully incorporated above; none are left outstanding.

**Domain modeling pass:** vocabulary sharpened and recorded in `../GLOSSARY.md` — notably distinguishing **Secret Ciphertext** (at rest, in SQLite) from **Decrypted Secret** (transient, main → Query Execution Service only), naming **Execution ID** for the `cancel()` handle, and clarifying **Test Connection** vs **Connect** (the former never populates the live pool). The main-process-only `safeStorage` constraint and its resolution (decrypt once in main, hand plaintext to the utilityProcess) met all three ADR criteria (hard to reverse, surprising without context, real tradeoff) — recorded as `../adr/0001-decrypt-credentials-in-main-pass-plaintext-to-utility-process.md`.

**Flag for ticket 11 (Testing & CI tooling):** this contract's process split has direct test-strategy implications. The Database Provider Interface and its Providers are plain-Node-testable in isolation (`connect(profile, secret)` takes an already-decrypted secret — no Electron runtime needed to unit-test provider logic). The Connection Manager (SQLite + `safeStorage` + MSAL) is main-process-only and cannot be exercised under plain Node/Vitest — it needs an actual Electron runtime (e.g. Playwright's Electron support, or Electron's own test harness) to test for real. The main↔utility `MessagePort` handoff of the Decrypted Secret is a new integration-test seam worth explicit coverage (confirm the secret reaches the Query Execution Service and is never leaked back out). Ticket 11 should pick its framework(s) with this three-way split in mind rather than assuming one test runner covers all of it.

**Downstream impact:** This is the destination artifact — the last major architecture decision this map set out to lock. No further tickets are blocked by anything decided here; ticket 11 carries a test-strategy flag (above) but not a blocking dependency.


