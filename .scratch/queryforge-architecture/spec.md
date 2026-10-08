# QueryForge — MVP Implementation Spec

**Tracker:** local markdown (`.scratch/queryforge-architecture/`) — no git remote configured for this repo; issues/ADRs/research already follow this convention.
**Label:** ready-for-agent
**Source:** `map.md` (all 11 tickets resolved, Destination locked), `.docs/product-overview.md`, `GLOSSARY.md`, `adr/0001-decrypt-credentials-in-main-pass-plaintext-to-utility-process.md`

## Problem Statement

Developers, database engineers, and other technical users who work with Azure Cosmos DB for NoSQL and Azure SQL Database have no single desktop tool to connect to, query, explore, and export data from both — they either juggle separate vendor-specific tools (Azure Data Studio, Azure Storage/Cosmos Explorer) or fall back to portal UIs, losing a consistent, keyboard-driven, DataGrip-like workflow. Existing generic DB clients either don't support Cosmos DB's query model (RU charges, continuation tokens, partition keys, nested-document structure) at all, or bolt it on awkwardly alongside relational tools.

Separately, before any implementation can start, QueryForge's foundational technical decisions (desktop framework, UI framework, query editor, data grid, driver strategy, local persistence, auth/credential storage, distribution) and its §6 component contracts were unresolved — building without locking these first risked rework (e.g. picking an editor or grid that doesn't fit the chosen desktop framework, or a credential-storage design that collides with the process model chosen for query execution, as happened with `safeStorage`'s main-process-only constraint).

## Solution

Build the QueryForge MVP: a cross-platform (macOS + Windows; Linux best-effort/future) Electron desktop application providing a unified, DataGrip-like interface for managing Azure Cosmos DB and Azure SQL connections, writing and executing queries, viewing results as tables or JSON, and exporting to CSV/JSON — implemented on the stack and component contracts locked across `map.md`'s 11 tickets:

- **Desktop framework:** Electron.
- **UI framework:** React + TypeScript.
- **Query editor:** CodeMirror 6 (SQL + Cosmos DB for NoSQL syntax highlighting). **Autocomplete is explicitly out of scope for MVP** — the user confirmed "I do not need code complete" during ticket 04, which supersedes `.docs/product-overview.md` §4.3/§9's listing of "Autocomplete for SQL keywords" as Required. Query formatting is a want, not a must — include it if low-cost (e.g. a free/MIT formatter such as `sql-formatter`), but it does not block MVP completion.
- **Data grid:** TanStack Table + TanStack Virtual, with hand-built clipboard (copy cell/row/value), column resize, and row numbers.
- **Driver strategy / execution process model:** native JS/TS SDKs (`@azure/cosmos`, `mssql`), executed in-process inside a single shared Electron `utilityProcess` (not per-tab, not `worker_threads`, not a separate Java service).
- **Local persistence:** SQLite (`better-sqlite3`) for Connection Profiles, Secret Ciphertext, saved queries, and query history; a JSON file for preferences; hand-rolled schema migrations (version table + ordered `.sql` files).
- **Auth / credential storage:** self-rolled `safeStorage`-backed encryption for every secret (SQL credentials, Cosmos account keys, MSAL token cache), stored as Secret Ciphertext in SQLite. Entra ID auth via `msal-node`'s interactive Authorization Code + PKCE flow (`acquireTokenInteractive`, system browser + loopback redirect) with a self-rolled `ICachePlugin` — no `keytar`, no `@azure/msal-node-extensions`, no device code, no ROPC, no embedded `BrowserWindow`.
- **Distribution:** `electron-builder`, unsigned local builds (macOS `.dmg`/`.zip`, Windows NSIS/portable `.exe`) — no code-signing, no notarization, no auto-update, matching the current local-only usage model.

The application follows the §6/§7 architecture: presentation (User Interface), connection/credential lifecycle (Connection Manager), query execution (Query Execution Service), database-specific logic behind a common contract (Database Provider Interface, with Cosmos DB Provider and Azure SQL Provider implementations), local persistence (Local Storage Service), and export (Export Service) are kept as separate, independently testable components — see Implementation Decisions below for exact boundaries.

## User Stories

1. As a QueryForge user, I want to install and launch the application on macOS or Windows, so that I can start working without a hosted backend or centralized service.
2. As a QueryForge user, I want to create a new Azure Cosmos DB connection (endpoint, auth method, account key or Entra ID, database, container, optional timeout), so that I can connect to my Cosmos data.
3. As a QueryForge user, I want to create a new Azure SQL connection (server hostname, port, database, auth method, username/password or Entra ID, encryption/TLS settings, timeout), so that I can connect to my SQL data.
4. As a QueryForge user, I want to edit an existing Connection Profile, so that I can fix or update connection details without recreating it.
5. As a QueryForge user, I want to delete a saved Connection Profile, so that I can remove connections I no longer need.
6. As a QueryForge user, I want to test a connection's parameters before saving it, so that I can catch misconfiguration early without polluting my live connection pool.
7. As a QueryForge user, I want to connect and disconnect from a saved connection, so that I control when a live session to my database is active.
8. As a QueryForge user, I want to assign a friendly display name to each connection, so that I can tell my connections apart at a glance.
9. As a QueryForge user, I want to organize my connections into groups or folders, so that I can manage many connections without clutter.
10. As a QueryForge user, I want to see each connection's current status (connected/disconnected/error), so that I know what's live before I run a query.
11. As a QueryForge user, I want QueryForge to remember my recently used connections, so that I can reconnect quickly.
12. As a QueryForge user, I want my credentials stored securely and never in plaintext, so that my database access isn't exposed if my machine or its files are compromised.
13. As a QueryForge user, I want to authenticate to Azure resources via Microsoft Entra ID using my normal browser sign-in, so that I can use enterprise auth without typing a password into the app or using a deprecated/phishable flow.
14. As a QueryForge user, I want to browse my Cosmos DB account's databases, containers, container properties, partition key definitions, and sample documents, so that I can understand my data's shape before querying it.
15. As a QueryForge user, I want to browse my Azure SQL database's schemas, tables, views, columns/data types, primary keys, and indexes, so that I can understand my schema before querying it.
16. As a QueryForge user, I want to refresh a connection's object-explorer metadata without restarting the app, so that I see schema changes made elsewhere.
17. As a QueryForge user, I want to double-click an object in the explorer to open a query editor or view sample records, so that I can jump straight into working with it.
18. As a QueryForge user, I want a query editor with SQL and Cosmos DB for NoSQL syntax highlighting, automatic indentation, bracket/parenthesis matching, line numbers, find-and-replace, and undo/redo, so that I can write queries efficiently and correctly.
19. (Removed — superseded by ticket 04: the user confirmed no autocomplete requirement, keyword or metadata-aware, for MVP. See Out of Scope.)
20. As a QueryForge user, I want query formatting available if it's low-cost to add, so that I can keep my queries readable — this is a want, not a must, and does not block MVP completion (ticket 04).
21. As a QueryForge user, I want multiple independent query editor tabs, each with its own active connection and database context, so that I can work on several queries/connections at once without them interfering.
22. As a QueryForge user, I want my query tab's contents retained when I switch tabs, so that I don't lose in-progress work.
23. As a QueryForge user, I want to save a query to a local file and reopen previously saved queries, so that I can persist and reuse my work outside the app's own history.
24. As a QueryForge user, I want to execute the current query or just the selected query text, so that I can run a whole script or just a fragment.
25. As a QueryForge user, I want to execute a query with `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux), so that I can run queries without leaving the keyboard.
26. As a QueryForge user, I want to cancel a running query, so that I can stop a query that's taking too long or was a mistake.
27. As a QueryForge user, I want to see a clear indication of query execution progress, so that I know the app hasn't frozen.
28. As a QueryForge user, I want the UI to stay responsive while a query runs, so that I can keep working in other tabs.
29. As a QueryForge user, I want each tab's query execution to be independent of other tabs, so that a slow or stuck query in one tab doesn't block another.
30. As a QueryForge user, I want to see a clear error message without losing my original query text when a query fails, so that I can fix and retry without retyping.
31. As a QueryForge user, I want large Cosmos DB or Azure SQL result sets to load incrementally rather than freezing the UI or exhausting memory, so that I can work with big results safely.
32. As a QueryForge user, I want Cosmos DB cross-partition query support and automatic continuation-token handling, so that I don't have to manage pagination mechanics myself.
33. As a QueryForge user, I want Cosmos DB throttling (429) responses handled with retry, so that transient RU exhaustion doesn't surface as a hard failure.
34. As a QueryForge user, I want to see query execution duration for every query, so that I can judge performance.
35. As a QueryForge user, I want to see the Cosmos DB request charge (RU) for a query when available, so that I can monitor and control my RU consumption.
36. As a QueryForge user, I want Azure SQL query timeouts respected and configurable, so that a runaway query doesn't hang indefinitely.
37. As a QueryForge user, I want Azure SQL execution errors shown with useful detail (not just a generic failure), so that I can diagnose and fix my query.
38. As a QueryForge user, I want to view query results in a resizable, virtualized table with row numbers, horizontal/vertical scrolling, and clear NULL-value display, so that I can explore large results efficiently.
39. As a QueryForge user, I want to copy individual cells, selected rows, or selected values from the results grid, so that I can reuse result data elsewhere.
40. As a QueryForge user, I want to view results as pretty-printed, syntax-highlighted JSON with collapsible objects/arrays, so that I can inspect Cosmos DB's nested document structure naturally.
41. As a QueryForge user, I want to expand a table cell containing an object or array into a detailed JSON inspector, so that I can see nested values without switching the whole view.
42. As a QueryForge user, I want to copy or save the JSON view's contents, so that I can reuse or archive a result outside the app.
43. As a QueryForge user, I want to switch between table and JSON views of the same result without re-executing the query, so that I can look at the same data two ways cheaply.
44. As a QueryForge user, I want to see total rows loaded, execution duration, and any errors directly alongside my results, so that I have execution context without hunting for it.
45. As a QueryForge user, I want to export currently loaded query results to CSV or JSON, so that I can use the data outside QueryForge.
46. As a QueryForge user, I want the option to export all matching rows (not just the currently loaded page) via continued retrieval, so that I can get a complete export of a large result set.
47. As a QueryForge user, I want a clear UI distinction between "export loaded rows" and "export all matching rows," so that I don't accidentally under- or over-export.
48. As a QueryForge user, I want to choose the output file location for an export, see export progress, and cancel an in-progress export, so that I stay in control of large export operations.
49. As a QueryForge user, I want CSV exports to properly escape values and use UTF-8 encoding, and JSON exports to preserve native JSON structure, so that exported files are correct and portable.
50. As a QueryForge user, I want QueryForge to automatically maintain a local history of executed queries (including last execution time, status, and duration), so that I can find and reuse past work.
51. As a QueryForge user, I want to save frequently used queries and associate them with a connection or database type, so that I can organize reusable queries.
52. As a QueryForge user, I want to search my query history, so that I can find a past query without scrolling through everything.
53. As a QueryForge user, I want query history to avoid persisting sensitive query parameters unless I explicitly opt in, so that I don't accidentally retain sensitive data at rest.
54. As a QueryForge user, I want dark and light themes and resizable panels, so that I can tailor the layout and appearance to my preference.
55. As a QueryForge user, I want the app to preserve unsaved query text across an unexpected shutdown where feasible, so that a crash doesn't cost me in-progress work.
56. As a QueryForge user, I want my saved connections and saved queries to still be there when I close and reopen the app, so that the app is reliably stateful across sessions.
57. As an implementer picking up this spec, I want the Database Provider Interface's method surface (`connect`, `testConnection`, `disconnect`, `executeQuery`, `cancel`, `getMetadata`) and asymmetric cancellation semantics documented precisely, so that I can implement the Cosmos DB Provider and Azure SQL Provider without guessing at the contract.
58. As an implementer picking up this spec, I want the Connection Manager / Query Execution Service process boundary (and the main→utilityProcess Decrypted Secret handoff) documented, so that I don't accidentally reintroduce a live DB connection in main or try to call `safeStorage` from the utility process.
59. As a QueryForge user, I want to mark a connection as read-only, so that I reduce the risk of accidentally modifying data through a connection I only intend to explore (§8 Security).
60. As a QueryForge user, I want the application to render correctly on high-resolution (HiDPI/Retina) displays, so that the UI is sharp on modern hardware (§8 Usability).
61. As a QueryForge user, I want to execute multiple SQL statements in one query submission where practical, so that I can run short scripts, not just single statements (§4.4).
62. As a QueryForge user, I want QueryForge to handle an expired Entra ID credential gracefully (clear messaging, a path to re-authenticate) rather than a raw failure, so that I can recover without restarting the app (§8 Reliability).
63. As a QueryForge user, I want QueryForge to recover cleanly from a network interruption during a connection or query, so that a dropped network doesn't leave the app in a broken or ambiguous state (§8 Reliability).

## Implementation Decisions

**Process/component boundaries (§6, locked on ticket 10):**
- **Desktop Application Shell** (Electron main): window/app lifecycle, IPC routing.
- **Connection Manager** (main): Connection Profile CRUD in SQLite; `safeStorage` encrypt/decrypt of every secret (SQL credentials, Cosmos account keys, MSAL token cache), producing/consuming Secret Ciphertext; owns the Entra ID `acquireTokenInteractive` + self-rolled `ICachePlugin` flow. Never holds a live database connection. `safeStorage` access is wrapped behind a thin `SecretStore` interface so Connection Manager logic is unit-testable against a mock.
- **Query Execution Service** (the shared Electron `utilityProcess`): receives a Decrypted Secret once per `connect()` over the main↔utility `MessagePort`; owns live Database Provider instances and connection pools keyed by Connection Profile (not by tab, to avoid fragmenting `mssql`'s per-pool behavior across tabs); executes queries; tracks Execution IDs for `cancel()`; streams Result Chunks back to main.
- **Database Provider Interface**: the contract implemented by each Database Provider, running inside the Query Execution Service.
- **Cosmos DB Provider** / **Azure SQL Provider**: concrete implementations using `@azure/cosmos` and `mssql` respectively.
- **Local Storage Service** (main): owns the SQLite file and the JSON preferences file; Connection Manager is a consumer of it.
- **Export Service** (main): consumes the same result stream the renderer displays and writes to disk directly from main (avoids an extra process hop for large result sets).
- **User Interface** (renderer): CodeMirror 6 editor, TanStack Table/Virtual grid, Object Explorer. Never touches SQLite, `safeStorage`, or DB drivers directly — everything proxied through `contextBridge` + IPC to main, which routes DB-specific calls to the Query Execution Service.

**Database Provider Interface method surface (locked):**
```
connect(profile, secret) -> void
testConnection(profile, secret) -> TestResult
disconnect() -> void
executeQuery(query, options) -> AsyncIterable<ResultChunk>   // streamed/paginated, never one big array
cancel(executionId) -> void                                   // asymmetric semantics, documented per provider
getMetadata() -> DatabaseMetadata                             // for the Object Explorer; not an editor-autocomplete consumer
```
- `secret` is always a Decrypted Secret handed over from main at connect-time; the interface and its implementations never take ciphertext and never call `safeStorage` directly.
- `cancel(executionId)` semantics are asymmetric and must be documented as such, not papered over: Azure SQL's cancel is genuine server-side cancellation (TDS Attention packet via `Request.cancel()`); Cosmos DB's is client-side abandonment only via `AbortSignal` (RU charges already incurred stand; the request may still complete server-side).
- `ResultChunk` carries rows plus an optional, provider-specific `meta` field (e.g. `{ ru?: number }` for Cosmos, omitted for SQL).
- `getMetadata()` returns a shared, provider-agnostic shape (tables/columns for SQL; containers/partition keys for Cosmos) generic enough for the Object Explorer to render without provider-specific branching in the UI layer.
- The interface is provider-agnostic in principle (§7) but is not designed against any concrete future provider (Postgres/MySQL/SQLite/MongoDB are explicitly out of scope for this contract).

**Credential handling (ADR 0001):** `safeStorage` is Electron main-process-only and unreachable from the `utilityProcess`. Main decrypts a Secret Ciphertext into a Decrypted Secret at `connect()` time and hands it once, over the main↔utility `MessagePort`, to the Query Execution Service, which uses it immediately to construct the DB client and never persists or re-transmits it. This is an accepted, documented tradeoff (brief plaintext transit over an internal, trusted channel, once per connection, not per query) — not an oversight to "fix" later.

**Local persistence:** SQLite (`better-sqlite3`) holds Connection Profiles, Secret Ciphertext, saved queries, and query history; a separate JSON file holds preferences. Schema migrations are hand-rolled (a version table plus ordered `.sql` files) — no migration library dependency.

**Auth:** Entra ID authentication uses `msal-node`'s interactive Authorization Code + PKCE flow (`acquireTokenInteractive`, system browser + loopback redirect), explicitly not device code (phishing-flagged), not ROPC (deprecated, breaking further in March 2026), and not an embedded `BrowserWindow` (discouraged industry-wide). No `keytar`, no `@azure/msal-node-extensions` — both ruled out due to the dependency on the archived `keytar` library.

**Distribution:** `electron-builder` producing unsigned local builds (macOS `.dmg`/`.zip`; Windows NSIS/portable `.exe`). No notarization, no code-signing certificate, no auto-update for the current local-only usage model; the tool choice specifically allows signing/auto-update to be enabled later without migrating packaging tools.

**No-fee / open-source constraint:** every shipped library/component (query editor, data grid, drivers, persistence, packaging) must be free and open-source (e.g. MIT, Apache 2.0) — no paid tiers or commercial licenses anywhere in the shipped stack. This does not apply to test-only tooling that never ships (see Testing Decisions).

## Testing Decisions

Per ticket 11, testing follows a three-way split driven directly by the process model above — no single framework covers all of it:

- **Unit tests — Vitest (MIT):** the Database Provider Interface and its implementations (Cosmos DB Provider, Azure SQL Provider), plus other application services, are plain-Node-testable in isolation, since `connect(profile, secret)` always takes an already-decrypted secret and needs no Electron runtime. Test behavior (does a given query/options produce the expected streamed Result Chunks, does `cancel()` behave per its documented asymmetry), not implementation details. Build note for implementation: `better-sqlite3` is a native module compiled per-runtime ABI — plain-Node unit tests use the Node-ABI build; anything exercised inside the real Electron process needs an Electron-ABI rebuild (`@electron/rebuild`).
- **Main-process integration tests and renderer E2E — Playwright's Electron support (Apache-2.0):** covers the Connection Manager (SQLite + `safeStorage` round-trip, Entra ID flow scaffolding) which cannot be meaningfully unit-tested under plain Node since it is main-process-only by construction (ADR 0001); also covers the main↔utility `MessagePort` Decrypted Secret handoff as an explicit integration-test seam (confirm the secret reaches the Query Execution Service and is never echoed back to the renderer or logged); also covers renderer E2E (CodeMirror editor, TanStack grid, Object Explorer). Pattern: wrap `safeStorage` behind the `SecretStore` interface, mock it in Vitest unit tests, and reserve the real Electron runtime for the smaller set of tests that actually need to hit the OS-level `safeStorage` binding. Known limitation to carry into implementation: Playwright's Electron support is labeled "experimental"; CodeMirror 6 is a `contenteditable` surface requiring `pressSequentially()` rather than `fill()`; TanStack Virtual only renders visible rows, so tests must drive the scroll container and re-resolve locators by a stable attribute rather than holding element handles.
- **Cosmos DB integration tests:** the vNext Cosmos DB Emulator (Docker image, free but not open-source — acceptable since it is test-only tooling that never ships) via `testcontainers`'s `@testcontainers/azure-cosmosdb-emulator` module, as a fast smoke-test layer; a free-tier real Cosmos account backs anything the emulator can't cover (RU metering, feed APIs).
- **Azure SQL integration tests:** directly against a free-tier Azure SQL Database (serverless) instance — no local SQL Server container, due to ARM64/Rosetta fragility.
- **Container runtime:** Podman (Apache-2.0) over Docker Desktop, for the Cosmos emulator.
- **CI pipeline:** explicitly deferred. "Tests exist and run locally" is sufficient for the current local-only usage model; revisit if/when distribution or selling becomes a real goal.

Prior art: none yet in this repo — no code exists; this is the first implementation effort, following directly from the locked contracts above.

## Out of Scope

- **All query-editor autocomplete, including SQL-keyword autocomplete:** the user confirmed no autocomplete requirement during ticket 04 ("I do not need code complete") — this supersedes `.docs/product-overview.md` §4.3/§9's listing of keyword autocomplete as Required MVP scope. Metadata-aware autocomplete (tables/containers/columns) remains Phase 2 as originally scoped.
- **Phase 2 / Future features** (§9 MVP table): advanced database object management, Excel (XLSX) export, JSON Lines export, SQL INSERT-statement export, additional database providers beyond Cosmos DB and Azure SQL, schema comparison, visual query builder, stored procedure browsing.
- **Linux support:** best-effort/future only, not required for MVP (§3).
- **Code signing, notarization, and auto-update:** explicitly deferred — unsigned local builds are acceptable for the current local-only usage model (revisit if/when distribution or selling becomes a goal).
- **Automated CI pipeline:** explicitly deferred for the same reason.
- **Concrete design of future database providers** (Postgres, MySQL, SQLite, MongoDB): the Database Provider Interface is kept provider-agnostic in principle but none of these are designed against.
- **This spec does not cover UI visual/interaction design beyond what's in `.docs/product-overview.md` §5's wireframe** — detailed UI design is left to implementation.

## Further Notes

- No code exists yet for QueryForge; this spec is the first implementation effort following the architecture map. All 11 tickets on `map.md` are resolved and its Destination is locked — nothing here should be treated as still-open unless explicitly flagged above.
- Domain vocabulary (Connection Profile, Secret Ciphertext, Decrypted Secret, Connection Manager, Query Execution Service, Database Provider Interface, Database Provider, Execution ID, Result Chunk, Database Metadata, SecretStore, Test Connection) is recorded in `/GLOSSARY.md` (repo root) and should be used as-is throughout implementation, including in code identifiers and test names where practical — see each term's `_Avoid_` list for near-miss names that would blur a meaningful distinction (e.g. "Secret" alone is ambiguous between Secret Ciphertext and Decrypted Secret; "Driver" means the underlying SDK, not a Database Provider).
- The credential-handoff design is recorded as `/docs/adr/0001-decrypt-credentials-in-main-pass-plaintext-to-utility-process.md` (repo root); a future reader should consult it before "fixing" the main→utilityProcess plaintext transit as if it were an oversight.
- Suggested build order mirrors `.docs/product-overview.md` §11 (Phases 1–5) and §14's vertical slice: application shell + local persistence + Connection Profile management, then the Database Provider Interface + both providers + connection testing + metadata discovery, then the query editor + execution + cancellation, then results/export, then history/saved-queries/themes/tests/packaging — but this spec does not mandate ticket-by-ticket sequencing beyond that ordering; the implementation effort may re-slice as needed.
- `GLOSSARY.md` and `adr/` have been relocated to the repo root (from `.scratch/queryforge-architecture/`) now that implementation has started, per this note.
- **Build tooling note (not locked by `map.md`, no ticket covers it):** the map's 11 tickets decided the framework/libraries but not the dev-build toolchain gluing Electron + React + TypeScript together. Implementation uses **electron-vite** (MIT) — a thin, actively maintained Vite integration for Electron's main/preload/renderer multi-target build, avoiding a hand-rolled webpack/esbuild setup. This is an implementation default, not a map decision; revisit only if it causes real friction.
