Type: grilling
Blocked by: 02
Status: resolved

## Question

Should QueryForge execute database queries using native JavaScript/TypeScript SDKs running in-process (within the desktop framework chosen in ticket 02), or via a separate Java-based database execution service (product-overview.md §10.5)? Consider Cosmos DB and Azure SQL SDK maturity in the chosen runtime, process-isolation/crash-containment for long-running or misbehaving queries, and the packaging complexity of bundling a second runtime (JVM) alongside the desktop app.

**Now that ticket 02 resolved to Electron**, this ticket also needs to pin down the query-execution process model, since §4.4 requires "query execution must not freeze the user interface" and §8 calls for "background or worker-based query execution": should queries run via Node `worker_threads` (same-process concurrency) or Electron's `utilityProcess` API (stronger isolation/crash containment, more overhead per query)? Research ticket 01 (§6) noted community reports of stability issues under sustained heavy `worker_threads` use — factor that into the choice, especially for long-running or many-queries-per-session usage.

## Answer

**Driver strategy: native JS/TS SDKs in-process** (`@azure/cosmos`, `mssql`/`tedious`), no separate Java service.

**Query-execution process model: a single shared Electron `utilityProcess`** (not one per tab).

Full research: [`research/06-query-execution-model.md`](../research/06-query-execution-model.md).

Rationale, confirmed with the user:
- Driver strategy was effectively settled by ticket 02 — Electron was chosen specifically because the official JS SDKs run unmodified in its Node main process. A Java-based service would reintroduce a second runtime (JVM) for no remaining benefit.
- Process model: async DB I/O never blocks anything by itself — isolation isn't needed just to make the network call. The real risks are (a) CPU-bound JSON work on large result sets blocking main's event loop, which Electron's own docs say freezes the *entire app* (not just IPC) — isolation helps here — and (b) the same payload freezing the *renderer's* own paint on deserialization, which backend isolation does **not** fix (only pagination/streaming does, per §4.4/§8's existing incremental-processing requirement — unchanged, not solved by this ticket).
- `worker_threads` was rejected: it shares main's OS fault domain (a native crash takes the whole app down), has a specific open 2025 Electron regression (crash after ~10min runtime), and Node has a long history of worker-thread memory-leak reports.
- `utilityProcess` was chosen for genuine OS-level crash containment, explicitly positioned by Electron for "crash-prone components" — fitting for a component executing arbitrary user-written queries against two different DB engines.
- **Single shared instance, not per-tab**: per-tab process isolation would fragment `mssql`'s connection pooling (N tabs = N separate pools against the same server). One shared `utilityProcess` keys connection pools by connection profile, not by tab, avoiding that cost. (Cosmos has no comparable pooling concern — its SDK manages its own HTTP/TCP pooling internally.)
- Cancellation is SDK-level in both providers regardless of process placement — `mssql`'s `Request.cancel()` sends a genuine server-side TDS Attention packet; Cosmos's `abortSignal` is client-side abandonment only (RU charges already incurred are not undone). This asymmetry is a fact for the UI/UX layer to surface, not an architecture decision.

**Downstream impact:** Unblocks ticket 10 (Provider Interface contract) — the last blocker is now clear. Flags carried into ticket 10's body: execute inside the shared `utilityProcess` with pooling keyed by connection profile, and preserve the cancellation asymmetry between providers rather than assuming both behave identically.
