Type: grilling
Status: resolved

## Question

Graduated from the map's "Not yet specified" fog now that both of its gating decisions (Desktop Framework, ticket 02; Driver Strategy, ticket 06) have landed.

What test framework(s) should QueryForge use for unit tests (application services, Provider Interface implementations) and integration tests (the Cosmos DB / Azure SQL providers against real or emulated endpoints), per §8 NFR's "Unit tests for application services" and "Integration tests for database providers"? Given the stack now locked — Electron, React + TypeScript, CodeMirror 6, TanStack Table/Virtual, a shared `utilityProcess` driver host — and the standing no-fee constraint (Notes), candidates should be free/open-source (e.g. Vitest, Jest, Playwright for any E2E needs).

Also decide: given the current usage model is local-only with no CI pipeline yet (Notes) — should an automated CI pipeline (§8 NFR: "Automated builds") be set up now, or is "tests exist and run locally" sufficient for the present goal, with CI deferred until/if the usage model changes (distribution, selling)? State this as an explicit decision either way, not a silent default.

**Flag from ticket 10 (Provider Interface contract):** the locked process split has direct test-strategy implications — don't pick a single framework assuming it covers everything:
- The **Database Provider Interface** and its Providers (Cosmos DB, Azure SQL) are plain-Node-testable in isolation: `connect(profile, secret)` takes an already-decrypted `secret`, so unit tests never need an Electron runtime or real `safeStorage`.
- The **Connection Manager** (SQLite + `safeStorage` encrypt/decrypt + MSAL `acquireTokenInteractive`/`ICachePlugin`) is main-process-only by construction (ADR `../adr/0001-decrypt-credentials-in-main-pass-plaintext-to-utility-process.md`) and cannot be meaningfully unit-tested under plain Node — it needs an actual Electron runtime (e.g. Playwright's Electron support, or Electron's own test harness) to exercise for real.
- The **main↔utility `MessagePort` handoff** of the Decrypted Secret (main → Query Execution Service, once per connect) is a new integration-test seam worth explicit coverage: confirm the secret reaches the Query Execution Service and is never echoed back to the renderer or logged.

Pick framework(s) with this three-way split (plain-Node unit tests / Electron-runtime tests / IPC integration tests) in mind, not a single tool assumed to cover all of it.

## Answer

Full research: [`research/11-testing-ci-tooling.md`](../research/11-testing-ci-tooling.md).

**Unit tests (Provider Interface implementations, application services): Vitest.** Both Vitest and Jest are MIT; Jest's ESM support remains officially "experimental" and needs a Node flag, while Vitest is ESM-native with zero-config TypeScript. Nothing favors Jest for this project (React Native, the one case Vitest doesn't cover, is irrelevant to an Electron app). Build-note for the future implementation effort, not a design decision: `better-sqlite3` is a native module compiled per-runtime ABI — plain-Node unit tests use the Node-ABI build; anything later exercised inside the real Electron process needs an Electron-ABI rebuild (`@electron/rebuild`). The two aren't interchangeable without rebuilding.

**Main-process integration tests (`safeStorage` round-trip, the main↔utility `MessagePort` secret handoff) and renderer E2E: Playwright's Electron support, for both.** It's officially labeled "experimental" (an unanswered 2026 Playwright GitHub issue shows larger teams asking the same production-readiness question), and `@wdio/electron-service` is the more actively-developed non-experimental alternative — but Playwright is free/OSS (Apache-2.0), the most commonly used option, and one tool covering both main-process integration and renderer E2E minimizes tooling surface for a solo maintainer. Pattern: wrap `safeStorage` behind a thin interface, mock it in plain Vitest unit tests, and reserve the real Electron runtime (via Playwright) for the small number of integration tests that actually hit the OS keychain. Electron's own docs describe a manual IPC-over-stdio test-driver harness as a documented fallback if Playwright's Electron automation proves unreliable in practice — not a dead end. Implementation notes for later: CodeMirror 6 is a `contenteditable` surface — use `pressSequentially()`, not `fill()`, for anything with per-keystroke behavior; TanStack Virtual only renders visible rows, so tests must drive the scroll container and re-resolve locators by a stable `data-index`-style attribute rather than holding element handles.

**Cosmos DB integration testing: the vNext Cosmos DB Emulator** (Docker image, GA, now runs natively on Apple Silicon and Windows — the historical Apple Silicon gap is resolved) **via `testcontainers`** (MIT), which has a purpose-built `@testcontainers/azure-cosmosdb-emulator` module. The emulator is free but **not open-source** (Microsoft EULA) and has real documented gaps (no RU metering, no feed APIs, no GSIs, a reported continuation-token bug) — as test-only tooling that never ships in the product, it sits outside the no-fee/OSS stack constraint (which governs shipped libraries), but its gaps mean it's a fast smoke-test layer, not full fidelity. A free-tier real Cosmos account (1,000 RU/s + 25 GB, permanently free) is the fallback for anything RU- or feed-API-dependent.

**Azure SQL integration testing: skip local SQL Server containers; test directly against a free-tier Azure SQL Database (serverless) instance.** SQL Server has no native ARM64 Docker image (Apple Silicon needs Rosetta 2, and a SQL Server 2025 AVX/Rosetta crash was only fixed in CU1 — a fragility signal); Azure SQL Edge, the old ARM64-native workaround, was retired September 2025. The free-tier Azure SQL offer (100,000 vCore-seconds + 32 GB/month, no expiration) is the real engine with zero wire-compatibility gaps, at $0 marginal cost — simpler and more faithful than fighting container emulation for one provider while already depending on a Microsoft-hosted emulator for the other.

**Container runtime for the Cosmos emulator: Podman** (Apache-2.0), not Docker Desktop. Docker Desktop's free tier covers this project today, but Podman is unambiguously free regardless of how the "may change later" usage model (map Notes) evolves — avoids ever having to revisit this.

**CI pipeline: deferred, explicitly.** Consistent with the standing local-only/no-CI constraint (same call already made on ticket 09): "tests exist and run locally" is sufficient for the current goal. Revisit if/when distribution or selling becomes a real goal.

**Downstream impact:** None of this map's other tickets are blocked by this choice. This was the last open ticket — the map's Destination (§10's decisions + §6 contracts) plus testing strategy are now fully locked.
