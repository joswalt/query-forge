# QueryForge

Cross-platform desktop database query/exploration tool (Azure Cosmos DB for NoSQL, Azure SQL Database). No code exists yet — this glossary (and the sibling `adr/` directory) captures vocabulary and decisions locked while planning the architecture map (`map.md`) and travels with it; relocate both to the repo root once implementation starts.

## Language

**Connection Profile**:
The persisted, non-secret description of a database connection (server/account address, database/container name, auth mode, display name) stored as SQLite metadata. Never contains plaintext credential material — only a reference to its Secret Ciphertext row.
_Avoid_: Connection, Connection Config

**Secret Ciphertext**:
The `safeStorage`-encrypted form of a credential (SQL password, Cosmos account key, MSAL token cache entry), persisted in SQLite. Decryptable only by the OS-held master key, and only from Electron's main process.
_Avoid_: Secret, Credential (both too ambiguous about encryption state — always say which state you mean)

**Decrypted Secret**:
The plaintext form of a credential, produced by decrypting a Secret Ciphertext in main at connect-time. Exists only transiently: handed once to the Query Execution Service over the main↔utility `MessagePort` and never persisted or re-transmitted beyond that — with one exception: an Entra ID / service principal *access token* is renewed in main and sent again when the Query Execution Service asks (ADR 0002). Never logged, never written to disk, never passed to the renderer.
_Avoid_: Secret (ambiguous — see Secret Ciphertext)

**Connection Manager**:
The main-process component owning Connection Profile CRUD, Secret Ciphertext encrypt/decrypt, and the Entra ID auth flow. Never holds a live database connection — that's the Query Execution Service's job.
_Avoid_: Credential Manager, Connection Service

**Query Execution Service**:
The runtime component living inside the shared Electron `utilityProcess`. Receives a Decrypted Secret once per connect, owns the live Database Provider instances and their connection pools (keyed by Connection Profile, not by tab), executes queries, tracks Execution IDs for cancellation, and streams Result Chunks back to main.
_Avoid_: Query Engine, Execution Host

**Database Provider Interface**:
The contract (`connect`, `testConnection`, `disconnect`, `executeQuery`, `cancel`, `getMetadata`) that every Database Provider implements. A type/contract, not a running component — it has no identity or lifecycle of its own; the Query Execution Service is what instantiates and runs Providers against it.
_Avoid_: Provider Interface (ambiguous — which provider?), Driver Interface

**Database Provider**:
A concrete implementation of the Database Provider Interface for one database engine (Cosmos DB Provider, Azure SQL Provider). Owns its own connection pool and translates the interface's generic calls into engine-specific SDK calls.
_Avoid_: Driver (reserved for the underlying engine SDK/library, e.g. `mssql`, `@azure/cosmos`, which the Provider wraps — not the same thing)

**Execution ID**:
An opaque identifier the Query Execution Service assigns to one in-flight `executeQuery` call, used to address it for `cancel()`. Cancellation semantics behind the same Execution ID differ by Provider: Azure SQL's is genuine server-side cancellation (TDS Attention packet); Cosmos DB's is client-side abandonment only (RU charges already incurred stand, the request may still complete server-side).
_Avoid_: Query ID, Request ID

**Result Chunk**:
One unit of a streamed/paginated query result returned by `executeQuery`'s `AsyncIterable`. Carries rows, the Result Set they belong to, plus an optional provider-specific `meta` field (e.g. Cosmos's RU charge) that the UI may display but must not depend on existing.
_Avoid_: Page, Batch (both imply a pagination strategy uniform across providers, which §7 explicitly rules out)

**Row Limit**:
Cosmos DB only. `QueryOptions.maxRows` — the editor's Run sets it from the per-tab Row Limit dropdown (100 / 1,000 / 10,000 / 50,000 = `MAX_DISPLAY_ROWS`, the default / All rows) so a query like `SELECT * FROM c` stops paging (and stops spending request units) once that many rows are returned; the last Result Chunk then carries `meta.truncated` and the true row total is unknown (shown as "50,000+"). "All rows" omits it. Rows are fetched in SDK pages of 100, so a limit below 100 still reads one full page. "Export all matching rows" never sets it. The Azure SQL Provider ignores it.
_Avoid_: Page size (that is the SDK's `maxItemCount`, a fetch granularity, not a stop condition), Cap (the renderer's display-memory bound is a separate concern)

**Result Set**:
The rows produced by one row-returning statement of a query submission. A multi-statement SQL script yields several, in statement order; a single statement (and every Cosmos DB query) yields one. Result Chunks carry a zero-based `resultSet` index (omitted means 0) and never span two Result Sets; a zero-row chunk announces a statement that returned nothing. The results view shows one tab per Result Set.
_Avoid_: Recordset (mssql's name for it — a driver term), Statement Result

**Database Metadata**:
The shared, provider-agnostic shape `getMetadata()` returns — tables/columns for Azure SQL, containers/partition keys for Cosmos DB — consumed by the Object Explorer (§4.2). Distinct from editor-side autocomplete, which is out of scope for MVP (ticket 04).
_Avoid_: Schema (implies a rigid relational shape Cosmos doesn't have)

**SecretStore**:
The thin interface wrapping Electron's `safeStorage` (encrypt/decrypt) that the Connection Manager depends on. Exists so Connection Manager business logic can be unit-tested against a mock, reserving the real `safeStorage` binding for a small set of Electron-runtime integration tests (ticket 11).
_Avoid_: CredentialStore (collides with Secret Ciphertext/Decrypted Secret naming)

**Test Connection**:
A short-lived connection attempt (`testConnection`) used only to validate a Connection Profile's parameters before saving it. Does not populate the Query Execution Service's live connection pool — that only happens on a real `connect()`.
_Avoid_: Ping, Validate (both too generic — this is specifically the pre-save connectivity check)

**Query History Entry**:
A single automatically recorded past query execution — profile, status (`success`/`error`/`cancelled`), duration, row count, and timestamp — persisted in SQLite's `query_history` table after every run. Denormalizes the connection's display name at record time so an entry stays readable after its Connection Profile is renamed or deleted. The query text itself is withheld unless Preferences opts into persisting it.
_Avoid_: History Record (too generic), Query Log (implies append-only diagnostic output, not a user-facing reusable record)

**Preferences**:
The JSON-file-backed (not SQLite) settings owned by the Local Storage Service alongside its SQLite database (map.md ticket 07) — non-secret, non-Connection-Profile user settings. Holds whether Query History Entries persist query text, the theme (user story 54), and the Active Extractor with its Include header toggle.
_Avoid_: Settings (used informally elsewhere in product-overview.md, but "Preferences" is this codebase's identifier — e.g. `PreferencesStore`, `preferences.json`)

**Extractor**:
A named output format that turns result rows plus an explicit column list into text: CSV, TSV, JSON, Markdown, SQL Inserts, and so on (`src/shared/extractors/`). Pure, shared code: the renderer copies with it and main's Export Service writes files with it, so a copy and an export of the same rows are byte-identical (ADR 0003). Column-based Extractors take the grid's displayed columns; nested Cosmos values render as compact JSON.
_Avoid_: Format, Serializer, Export Format (the old `ExportFormat` `'csv' | 'json'` type it replaced)

**Active Extractor**:
The one Extractor every copy-rows and export action uses, chosen from the results header dropdown and persisted globally in Preferences (not per tab). "Copy cell" never uses it; it always copies the raw value.
_Avoid_: Default format, Current format

**Copy as / Export as**:
A copy or export parameterized by an Extractor. "Copy as ▸" on the grid context menu is a one-off copy in any Extractor that leaves the Active Extractor unchanged.
_Avoid_: Convert, Save as
