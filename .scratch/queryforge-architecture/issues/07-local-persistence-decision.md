Type: grilling
Blocked by: 02
Status: resolved

## Question

What should QueryForge use for local persistence of application preferences, saved connection profiles (excluding plaintext secrets), saved queries, and query history — SQLite, application configuration files, or a combination (product-overview.md §10.6)? Consider query-ability of history/saved-queries, migration strategy as schema evolves, and the SQLite driver maturity surfaced by ticket 01/02's framework choice.

## Answer

**Combination**: SQLite (`better-sqlite3`, MIT) for saved connection profiles, saved queries, and query history; a plain JSON config file for app preferences (theme, window bounds, last-used connection). Hand-rolled migrations: a `schema_version` table + ordered `.sql` files applied in a transaction at startup, no migration library.

Rationale, confirmed with the user:
- `better-sqlite3`'s maturity was already vetted in ticket 01's research (N-API ABI-stable, MIT, widely used in Electron apps). The three data types that need it — connection profiles, saved queries, query history — are structured and, per §4.7, query history specifically must be *searchable*, which is SQLite's sweet spot.
- App preferences are simple key-value toggles with no query need — a JSON config file avoids reaching for SQL to read a single setting, and keeps the two persistence mechanisms matched to genuinely different data shapes rather than forcing one DB "for consistency."
- Migrations: hand-rolled chosen over a library (e.g. `umzug`) — a `schema_version` table + sequential `.sql` files is a well-understood, small pattern for an app this size, and avoids adding a dependency (and another license to track under the no-fee constraint) for something straightforward to own directly.

**Downstream impact:** Unblocks nothing further (07 had no dependents). Flag added to ticket 10's body (Provider Interface contract): connection profiles are split across SQLite (metadata) and the OS credential store (secret, per ticket 08), not a single record.

**Superseded by ticket 08 (Auth / Credential Storage):** the "OS credential store (secret)" half of this split is more specific than stated above — ticket 08 resolved to a self-rolled `safeStorage`-backed layer, meaning the encrypted secret itself also lives in SQLite as a ciphertext column, not in a separate named OS-keychain entry. The only thing actually OS-held is `safeStorage`'s single app-level master encryption key. See ticket 08's Answer and ticket 10's body for the current model.
