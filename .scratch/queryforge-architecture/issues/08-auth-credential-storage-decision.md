Type: grilling
Blocked by: 02
Status: resolved

## Question

How should QueryForge integrate with OS-native credential stores (macOS Keychain, Windows Credential Manager) and support Microsoft Entra ID authentication for Azure Cosmos DB and Azure SQL (product-overview.md §10.7 / §4.1 security requirements), given the desktop framework chosen in ticket 02? Define the credential storage approach and the Entra ID auth flow (e.g., device code, interactive browser, MSAL library choice) for a desktop app context.

## Answer

**Credential storage: self-rolled, `safeStorage`-backed, used uniformly for all secrets** — SQL credentials, Cosmos account keys, and the MSAL token cache alike, each encrypted via Electron's `safeStorage` and persisted as ciphertext in SQLite. No `@azure/msal-node-extensions`, no `keytar`.

**Entra ID auth flow: interactive Authorization Code + PKCE via the system browser with a loopback (`http://localhost`) redirect** (`msal-node`'s `acquireTokenInteractive`). Not device code, not ROPC, not an embedded `BrowserWindow`.

Full research: [`research/08-auth-credential-storage.md`](../research/08-auth-credential-storage.md).

Rationale, confirmed with the user:
- `@azure/msal-node-extensions` (Microsoft's own official MSAL cache-persistence package) hard-depends on `keytar` — the same archived/unmaintained library (last release Feb 2022) ticket 01 already flagged for general credential storage. A Microsoft-authored migration proposal has sat open and unanswered since June 2024.
- `msal-node` exposes a documented `ICachePlugin` extension point, so the MSAL token cache can be serialized and encrypted via `safeStorage` directly — the exact mechanism already needed for SQL/Cosmos secrets — avoiding `keytar` entirely and keeping one consistent secret-storage mechanism project-wide instead of two.
- What's given up: `msal-node-extensions`'s cross-process file locking (irrelevant — QueryForge is a single Electron app, not multiple processes racing one cache file) and native-broker Windows SSO (an optional feature, not needed for MVP).
- Auth flow: Microsoft's own current guidance is unambiguous for a GUI desktop app with browser access — interactive PKCE is the recommended pattern (Microsoft's own Electron quickstart uses it); device code flow is now explicitly flagged by Microsoft as phishing-prone and fallback-only; ROPC is deprecated and breaks further under a Conditional Access enforcement change landing March 27, 2026; embedded `BrowserWindow` OAuth is discouraged industry-wide (Google bans it outright; Microsoft's 2025 direction moved away from it).
- Silent token refresh across app restarts works automatically via `acquireTokenSilent` once the cache plugin is wired correctly (refresh tokens for a genuine native/public-client app registration get a 90-day sliding window, not the 24-hour cap that applies only to SPA-type registrations) — correct app-registration platform type ("Mobile and desktop applications," not "Single-page application") matters and should be verified at implementation time, not assumed.

**Downstream impact:** Unblocks ticket 10 (Provider Interface contract) — its last blocker is now clear. Flag added to ticket 10's body, superseding ticket 07's earlier framing: secrets live as ciphertext in SQLite, not in a separate named OS-keychain entry; only `safeStorage`'s one master key is OS-held.
