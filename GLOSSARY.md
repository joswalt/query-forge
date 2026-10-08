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
The plaintext form of a credential, produced by decrypting a Secret Ciphertext in main at connect-time. Exists only transiently: handed once to the Query Execution Service over the main↔utility `MessagePort` and never persisted or re-transmitted beyond that. Never logged, never written to disk, never passed to the renderer.
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
One unit of a streamed/paginated query result returned by `executeQuery`'s `AsyncIterable`. Carries rows plus an optional provider-specific `meta` field (e.g. Cosmos's RU charge) that the UI may display but must not depend on existing.
_Avoid_: Page, Batch (both imply a pagination strategy uniform across providers, which §7 explicitly rules out)

**Database Metadata**:
The shared, provider-agnostic shape `getMetadata()` returns — tables/columns for Azure SQL, containers/partition keys for Cosmos DB — consumed by the Object Explorer (§4.2). Distinct from editor-side autocomplete, which is out of scope for MVP (ticket 04).
_Avoid_: Schema (implies a rigid relational shape Cosmos doesn't have)

**SecretStore**:
The thin interface wrapping Electron's `safeStorage` (encrypt/decrypt) that the Connection Manager depends on. Exists so Connection Manager business logic can be unit-tested against a mock, reserving the real `safeStorage` binding for a small set of Electron-runtime integration tests (ticket 11).
_Avoid_: CredentialStore (collides with Secret Ciphertext/Decrypted Secret naming)

**Test Connection**:
A short-lived connection attempt (`testConnection`) used only to validate a Connection Profile's parameters before saving it. Does not populate the Query Execution Service's live connection pool — that only happens on a real `connect()`.
_Avoid_: Ping, Validate (both too generic — this is specifically the pre-save connectivity check)
