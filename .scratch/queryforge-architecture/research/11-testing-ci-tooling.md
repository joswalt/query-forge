# Testing & CI tooling landscape (2025/2026) for QueryForge

Fact-finding only. No recommendation made here — see note at end of each section.
Confidence levels: **High** (primary source: official docs, npm/GitHub registry data,
vendor blog) / **Medium** (corroborated by multiple secondary sources) / **Low**
(single SEO/blog source, unverified benchmark, or stale/ambiguous data).

## Summary

- **Q1 (unit runner):** Both Vitest and Jest are MIT-licensed and actively maintained.
  Jest (OpenJS Foundation, donated by Meta in 2022) ships steady releases (30.x line,
  latest 30.5.2 as of Sep 2026) but its ESM support is still officially
  "experimental" and requires `--experimental-vm-modules`. Vitest (MIT, backed by
  VoidZero/Evan You) is ESM-native and needs no transform config for TS. Both are
  plain-Node-compatible, so both can test the Provider Interface code. No single
  "current default" is confirmed by a primary source; multiple secondary sources
  converge on Vitest being commonly recommended for new TS/ESM projects, but that is
  a Low-confidence aggregate claim, not an official position from either project.
- **Q2 (real Electron main-process testing):** Playwright's Electron support
  (`_electron`) is still labeled **"experimental"** by Playwright's own docs as of the
  current release, and a 2026 maintainer-facing GitHub issue asking directly "is this
  production-ready" got **no maintainer reply** before closure. It can call into main
  process code via `electronApp.evaluate()` (`require('electron')` in that context),
  so `safeStorage` is reachable in principle — but code-signing and `app.isReady()`
  caveats from prior research (file 10) still apply, and an unsigned dev build may not
  exercise the real OS keychain path. Spectron is confirmed dead (archived Feb 2022).
  `electron-mocha` still exists and works but has had no release in ~1 year (stale).
  WebdriverIO's Electron service is the most actively developed main-process-capable
  harness, but the package name changed (`wdio-electron-service` deprecated in favor of
  `@wdio/electron-service`) in 2025/2026. The realistic no-full-Electron-app pattern for
  `safeStorage` specifically is to wrap it behind a thin interface and mock that
  interface in plain unit tests, reserving the real `safeStorage` for a Playwright/WDIO
  integration test that launches the real app.
- **Q3 (Cosmos DB / Azure SQL local integration testing):** The Cosmos DB Emulator's
  new Linux-based "vNext" image is GA, runs natively on Apple Silicon and x64 via
  Docker (no more Windows-VM workaround), and is free of charge — but it is **not
  open-source** (proprietary Microsoft EULA), and it has real, documented query-feature
  gaps (no Request Units metering, no feed-read APIs, no User/Permission APIs, no GSIs,
  reported continuation-token query bugs) that matter for a query tool. SQL Server has
  **no native ARM64 Docker image**; Apple Silicon users run the x86_64 Linux image under
  Rosetta 2 emulation in Docker Desktop (a SQL Server 2025 AVX/Rosetta crash was fixed in
  CU1). Azure SQL Edge, the old ARM64-native workaround, was retired Sept 30, 2025. A
  new "Azure SQL Database container" (private preview per one source) also exists.
  `testcontainers` (Node package) is MIT-licensed, actively maintained, and has an
  official `@testcontainers/azure-cosmosdb-emulator` module. None of the emulator/SQL
  Server Docker images themselves are open-source — only the client libraries and
  Testcontainers tooling are. Docker Desktop itself requires a paid subscription for
  companies over 250 employees/$10M revenue (QueryForge as a FOSS hobby/community
  project likely qualifies for Docker Desktop's free tier, but this needs a human
  determination, not asserted here); fully free/OSS runtime alternatives are Podman
  (Apache-2.0), Rancher Desktop (Apache-2.0), and Colima (MIT).
- **Q4 (renderer E2E):** Playwright's Electron automation is the same tool as Q2 and is
  the most commonly referenced option for Electron+React E2E in 2025/2026 sources, but
  it is still officially "experimental" per Playwright's own docs, and real engineering
  teams are actively asking Playwright maintainers to clarify production-readiness
  without a public maintainer answer yet (as of the GitHub issue checked). WebdriverIO's
  `@wdio/electron-service` is the actively maintained alternative/successor lineage from
  Spectron. Both are free/OSS (Apache-2.0 and MIT respectively). CodeMirror 6 renders to
  a `contenteditable` div, so Playwright's `fill()` may not trigger per-keystroke
  handlers (autocomplete, linting) — `pressSequentially()` is the documented alternative
  for that case. TanStack Virtual only renders visible rows into the DOM, so naive
  `locator().count()`/full-table assertions don't work; the documented pattern is to
  locate by a `data-index`-style attribute and drive/assert against the scroll
  container, re-resolving locators after each scroll step rather than holding element
  handles (virtualized DOM nodes get recycled).

---

## 1. Unit test runner: Vitest vs Jest

**License (High confidence):**
- Jest: MIT, owned by the OpenJS Foundation since May 2022 (donated by Meta). Source:
  jestjs.io/blog, OpenJS Foundation blog.
- Vitest: MIT, copyright "VoidZero Inc. and Vitest contributors" (VoidZero is Evan
  You's company, also behind Vite). Source: npm registry page for `vitest`, GitHub
  `vitest-dev/vitest`.

**Maintenance activity (High confidence for Jest; Medium for Vitest cadence specifics):**
- Jest: steady minor/patch releases through 2025–2026 (30.0 → 30.5.2, latest checked
  Sep 18, 2026). ~5 core maintainers, "Sustainable"/"Healthy" ratings from Snyk's
  package health data. 167 open issues / 64 open PRs at time of check.
- Vitest: v5.0.3 was the current npm version at time of check (published ~1 week
  prior), repo updated as recently as the check date (Oct 7, 2026), 17k GitHub stars.
  Actively developed by the Vite/VoidZero team plus community (maintainers include
  ariperkkio, antfu, hiogawa, oreanno, Evan You per npm maintainer list).

**TypeScript support (High confidence, from official docs/behavior, corroborated by
multiple sources):**
- Vitest handles TypeScript natively via esbuild with no extra config; type-checking
  itself is left to `tsc`/IDE (not part of the fast test run).
- Jest requires `ts-jest` or `@swc/jest` as a separate transform layer; version/config
  mismatches between Jest and these transformers are a commonly reported first-run
  friction point.

**ESM support (High confidence — directly from Jest's own positioning, corroborated
widely):**
- Jest's ESM support remains **officially "experimental"** as of the 30.x line and
  still requires the `--experimental-vm-modules` Node flag; Jest 30 improved
  `import.meta`, `file://` URL, and package-exports handling but did not remove the
  experimental-flag requirement.
- Vitest is ESM-native from its first release (it runs on top of Vite's ESM-first
  pipeline) and runs ESM, CJS, and TS without flags.

**Community size (Medium confidence — single-source npm download comparison, likely
imprecise but directionally plausible):** One April-2026-dated secondary source put
Jest at roughly ~30M weekly npm downloads vs. Vitest's ~20M, i.e., Jest still has the
larger installed base but Vitest has closed much of the gap. **Low confidence** on the
exact numbers (SEO-blog sourced); **Medium confidence** on the qualitative claim
("Jest bigger, Vitest catching up") since it's repeated across several independent
secondary sources.

**Speed benchmarks cited by secondary sources (Low confidence — SEO/blog content,
not independently verified here):** Figures like "5.6x faster cold start," "Vitest 38s
vs Jest 214s on a 50k-test monorepo," and "8x faster watch mode" appear across several
2026-dated comparison-site articles (13labs.au, getautonoma.com, tech-insider.org,
qaskills.sh, devtoolswatch.com). These are not primary-sourced, not verified against
an actual benchmark run in this research, and should be treated as unverified
marketing-adjacent claims rather than facts.

**Is there a clear current default recommendation? (Low-to-Medium confidence, explicitly
not an official project position):** Multiple secondary sources converge on "Vitest is
commonly recommended as the default for new TypeScript/ESM-first projects in 2026;
Jest remains considered safe for large existing Jest codebases, React Native (where
Vitest has no support), and teams wanting the largest ecosystem." Neither project's own
docs make a claim about being "the" default for the other's use case — this is an
aggregate of secondary commentary, not a vendor statement.

**Electron-adjacency caveat not in the original question but directly relevant
(High confidence, from GitHub issues/project PRs on `better-sqlite3`):** Neither
runner changes the fact that native modules like `better-sqlite3` are compiled against
a specific Node ABI (`NODE_MODULE_VERSION`). Running Provider/service unit tests under
plain Node (Vitest or Jest, both run on the host Node binary) requires a Node-ABI build
of `better-sqlite3`; running anything inside the real Electron runtime (e.g., a
Playwright/WDIO integration test that exercises the Connection Manager) requires an
Electron-ABI rebuild (`@electron/rebuild`/`electron-rebuild`). The two builds are not
interchangeable — swapping contexts without rebuilding produces `ERR_DLOPEN_FAILED` /
`NODE_MODULE_VERSION mismatch` errors, a problem reported repeatedly across multiple
real projects' GitHub issues/PRs.

---

## 2. Testing real Electron main-process code (safeStorage, utilityProcess, IPC)

**Playwright's Electron support (`_electron`) (High confidence on status; Medium on
interpretation):**
- Playwright's own docs explicitly state Electron automation is **"experimental"**,
  supported "v21+" of Electron, with known issues around launch timeouts tied to the
  `nodeCliInspect` fuse. This designation has not changed to "stable" as of the current
  docs checked (Oct 2026).
- A main-process-capable API does exist: `electronApp.evaluate()` runs a callback in
  the Electron main process with `require('electron')` passed in, which is how
  Playwright's own docs demonstrate stubbing `dialog.showOpenDialog` etc. This means
  main-process-only APIs like `safeStorage` are reachable through this mechanism in
  principle (not explicitly demonstrated for `safeStorage` in any source found).
- A directly relevant primary-source data point: GitHub issue
  `microsoft/playwright#39477` (2026) is a developer explicitly asking Playwright
  maintainers whether "experimental" means production-ready or risky for a
  large-scale cross-platform Electron app, and asking whether system tray, native
  menus, and notifications are testable. As of the check, **no maintainer response is
  recorded** in the issue thread before it was closed as "not planned" — i.e., the
  production-readiness question was not answered by the Playwright team in that forum.
- Cross-referencing this project's own prior research (file
  `10-safestorage-utilityprocess.md`): `safeStorage`'s own doc restricts it to the
  "Main" process (not Utility), several of its methods behave unreliably before
  `app.ready`, and macOS keychain behavior depends on the app being code-signed. A
  Playwright-driven test against an **unsigned dev build** may therefore not faithfully
  exercise the real macOS Keychain path, even though the API call itself would succeed
  mechanically.

**Electron-specific test runners/harnesses (High confidence on current status):**
- **Spectron**: confirmed deprecated/archived by the Electron team as of Feb 1, 2022
  (official `electronjs.org/blog/spectron-deprecation-notice`). Electron's own docs
  point to Playwright and WebdriverIO as the recommended successors.
- **electron-mocha**: still present on npm (`13.1.0`, published Jan 16, 2025) and still
  gets ~15.5k weekly downloads, but has had **no release in roughly a year** as of
  late 2026 — Socket.dev rates its release cadence "not healthy" despite ongoing
  popularity. It runs Mocha tests inside a real Electron process (main or renderer),
  so it is capable of exercising main-process code, but its staleness is a maintenance
  concern for a 2026 adoption decision.
- **WebdriverIO Electron Service**: this is the actively-developed lineage. The
  original `wdio-electron-service` package (MIT, 9.2.1 latest, ~9,900 weekly downloads)
  is now **formally deprecated** in favor of the renamed, officially-adopted
  `@wdio/electron-service` package under the WebdriverIO org itself. The newer package
  adds main/renderer console log capture, class mocking, and deep-link testing, and
  exposes `browser.electron.execute()` to run code in the main process — a direct
  analogue to Playwright's `evaluate()`. This is presented by WebdriverIO/Electron docs
  as the closer "spiritual successor" to Spectron for full main-process-capable E2E.

**Realistic pattern for safeStorage specifically without a full Electron window
(Medium-High confidence, synthesized from Electron community conventions — no single
official doc spells this out end-to-end):**
1. Wrap `safeStorage.encryptString`/`decryptString`/`isEncryptionAvailable` behind a
   thin project-owned interface (e.g., a `SecretStore` abstraction).
2. Unit-test all logic that *consumes* that interface (Connection Manager business
   logic) using Vitest/Jest with a plain mock of the interface — no Electron runtime
   needed, works identically to any other dependency-injection mock.
3. Reserve the real `safeStorage` binding for a small number of **integration** tests
   that run inside an actual (even if headless/minimal) Electron process — via
   Playwright's `_electron` launcher or `@wdio/electron-service` — verifying the
   round-trip encrypt/decrypt against the real OS keychain/DPAPI/libsecret backend.
   This matches the general community pattern of mocking the `electron` module
   (`jest.mock('electron', ...)` / Jest `moduleNameMapper`) for everything *except* a
   deliberately-thin integration layer.
- No official Electron doc provides a "minimal headless harness" recipe specifically
  for `safeStorage`; Electron's own `tutorial/automated-testing` page instead describes
  a **custom IPC-over-stdio test-driver pattern** (spawn the real Electron binary via
  `child_process`, define RPC-callable methods in `main.js`, communicate over stdio) as
  its from-scratch alternative to both Playwright and WebdriverIO — this is a third,
  more manual option directly documented by Electron itself.

---

## 3. Cosmos DB / Azure SQL local/low-cost integration testing

**Azure Cosmos DB Emulator (High confidence on current GA/platform status):**
- The modern emulator is the **Linux-based "vNext" emulator**, which reached
  **General Availability** (per Microsoft's official devblog and a Microsoft video
  announcement) and ships as a single Docker image
  (`mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest`) that runs
  natively on **macOS (Apple Silicon and Intel) and Windows, both x64 and ARM64**, with
  no VM workaround needed. This directly resolves the historical gap (the older
  Windows-based emulator's Docker image was Linux-container-only in a way that didn't
  work on Apple Silicon without a Windows VM).
- It is **free of charge** but is **not open-source** — distributed under Microsoft's
  own emulator terms, not an MIT/Apache license. This matters against the project's
  "every tool/library must be free/open-source" constraint: it satisfies "free" but
  not "open-source."
- **Documented limitations relevant to a query tool (High confidence, from Microsoft's
  own feature-support docs and the Azure/azure-cosmos-db-emulator-docker GitHub repo):**
  only the **API for NoSQL**, in **gateway mode**, is supported; a feature-support table
  marks **Request Units metering, Read collection feed, and Read database feed as "not
  yet implemented"**; separately reported/confirmed gaps include **no User/Permission
  API support** (400 BadRequest on real service calls that succeed against the real
  Cosmos DB), **no Global Secondary Index (GSI) support**, and a **reported bug with
  non-streamable cross-partition query continuations** when using the
  `@azure/cosmos` JS/TS SDK specifically (works against the real service, fails on the
  emulator). The emulator team has also stated in a public GitHub discussion that they
  had to **pivot and rebuild the vNext query engine** to align with the real service's
  query codebase after an earlier approach didn't reach compatibility, meaning query
  fidelity has been actively in flux through 2025–2026, not a solved/stable baseline.

**Azure SQL / SQL Server locally (High confidence on ARM64 gap; Medium on newest
options):**
- There is still **no official native ARM64 Docker image** for SQL Server; Microsoft's
  own quickstart documents the image as supported only on Linux x86-64 hosts, with
  "emulation/translation environments (Rosetta 2, Prism, QEMU) not tested or
  supported" — in practice, Apple Silicon users run the x86_64 image via Docker
  Desktop's Rosetta-2-emulation setting. A SQL Server 2025 RTM bug caused crashes on
  this path due to AVX instruction requirements not being honored correctly under
  Rosetta emulation; this was fixed in SQL Server 2025 **CU1** (sources: Microsoft/
  community blogs, `nocentino.com`, `junian.dev`).
- **Azure SQL Edge**, which had offered a native-ARM64 workaround, was **retired
  effective September 30, 2025** and is no longer an option.
- A newer **"Azure SQL Database container"** (the actual Azure SQL engine, locally, in
  a container, compatible with `node-mssql`, Prisma, TypeORM, etc. by only changing the
  connection string) was found referenced in a Microsoft Azure SQL Dev Corner blog
  post, but the one source describing it uses "PRPR" (private preview) language —
  **its current general-availability status, ARM64/Apple-Silicon support, and exact
  licensing/cost terms were not independently confirmed** in this research and should
  be verified directly against Microsoft's current docs before being relied upon.
- Real-world/community pattern for local, no-CI integration testing against
  `mssql`/`tedious` (Medium confidence, synthesized from Microsoft docs + community
  discussion): run a disposable SQL Server/Azure-SQL-compatible container (via Docker
  or Testcontainers), seed an empty/disposable test database per run, and toggle
  `encrypt`/`trustServerCertificate` connection options via environment variables to
  switch between local-container and real-Azure-SQL targets without code changes. This
  was described as the common approach in multiple sources but not confirmed via a
  specific named real QueryForge-comparable open-source project.

**testcontainers (Node) (High confidence):**
- Package: `testcontainers` (core) is **MIT-licensed** (not Apache-2.0 — Apache-2.0 is
  used by the separate Rust implementation, `testcontainers-rs`, not the Node one),
  actively maintained (v12.2.0 found published ~8 days before the check, 2.6k GitHub
  stars). This is free/OSS tooling consistent with the project's constraint.
- There is an official, purpose-built module: **`@testcontainers/azure-cosmosdb-emulator`**
  (checked at v11.11.0) that wraps the Linux vNext Cosmos emulator image directly,
  exposing `.getEndpoint()`/`.getKey()` for use with `@azure/cosmos`'s `CosmosClient`.
  No equivalent first-party Azure-SQL-specific Testcontainers module was found in this
  research (a generic MSSQL-in-Docker Testcontainers recipe would need to be
  hand-rolled against the standard `mssql/server` image, subject to the ARM64
  caveats above).
- Testcontainers itself needs a container runtime (Docker or a compatible
  alternative) to function — see the Docker Desktop licensing note below, since that
  is a real dependency of this whole approach, not just an implementation detail.

**Docker Desktop licensing (High confidence, directly relevant to the "tooling must be
free/OSS" constraint):**
- Docker Desktop (the GUI application, distinct from the open-source Docker
  Engine/Moby project) requires a **paid subscription** for commercial use by
  organizations with 250+ employees **or** more than $10M annual revenue; it remains
  free for individuals, students, small businesses, and non-commercial/open-source use.
  Whether QueryForge's usage qualifies as free is a judgment call for a human, not
  resolved here.
- Fully free/OSS alternatives with no such threshold exist: **Podman**/Podman Desktop
  (Apache-2.0), **Rancher Desktop** (Apache-2.0, SUSE-maintained, bundles k3s), and
  **Colima** (MIT, CLI-only, macOS/Linux). **OrbStack**, which surfaced in the SQL
  Server/Apple-Silicon research as a workaround for the AVX/Rosetta crash, is itself
  **not free for commercial use** (free only for personal/non-commercial use under
  $10k/yr revenue) — relevant if it were being considered as a Docker Desktop
  replacement for this purpose.

**Azure free-tier levels still current as of 2026 (High confidence, from Microsoft's
own current docs):**
- **Cosmos DB**: lifetime free tier is still 1,000 RU/s + 25 GB storage, one per Azure
  subscription, unchanged as of this check.
- **Azure SQL Database**: a no-expiration free offer exists for serverless databases —
  100,000 vCore-seconds + 32 GB data + 32 GB backup storage free per database per
  month, up to 10 General Purpose databases per subscription.
- **Azure SQL Managed Instance**: separately, a time-limited free offer (720 vCore
  hours/month, 64 GB storage, up to 500 databases) lasts only the first 12 months
  after activation, then the instance stops unless upgraded to paid.
- These support the task's framing that hitting a real free-tier cloud instance at $0
  marginal cost is a viable fallback/complement to local emulation, independent of
  whatever local tooling decision is made.

---

## 4. E2E/UI testing for Electron + React renderer

**Is Playwright's Electron support the current standard? (Medium confidence — "most
commonly referenced," not "confirmed sole standard"):**
- The same Playwright `_electron` launcher from Q2 is the option most frequently
  referenced in 2025/2026 sources for Electron+React E2E (e.g., the widely-cited
  Electron React Boilerplate project's testing docs, and a found boilerplate combining
  Electron + React + TanStack + Vitest + Playwright). Playwright itself is **Apache
  License 2.0**, Microsoft-maintained, free/OSS, with no commercial fees — this
  satisfies the project's license constraint directly (High confidence).
- However, it is still officially labeled **"experimental"** by Playwright's own docs,
  and the same unanswered 2026 GitHub issue (`microsoft/playwright#39477`) shows a real
  engineering team asking directly about production-readiness for a large Electron app
  without getting a maintainer response — this tempers "standard" into "most commonly
  used option, maturity caveat acknowledged even by its adopters," not an
  unambiguous, maintainer-confirmed-stable recommendation.
- **@wdio/electron-service** (WebdriverIO, MIT) is the actively-maintained
  alternative/successor lineage from Spectron, also free/OSS, and is Electron's own
  docs' other explicitly recommended option alongside Playwright.
- No distinct "different current favorite" beyond these two was found; Cypress does
  not have first-class Electron desktop-app support in the sources checked (not
  directly verified here — absence of evidence, not evidence of absence).

**CodeMirror 6 (`contenteditable`) interaction specifics (Medium-High confidence,
from Playwright's own documented behavior plus community guidance):**
- CodeMirror 6 renders its editor surface as a `.cm-content` `contenteditable` div
  (a return to `contentEditable` after CM 2–5's different approach).
- Playwright's `locator.fill()` can set a contenteditable's text content directly, but
  for editors with per-keystroke handlers (autocomplete, linting-on-keystroke,
  bracket-matching — all plausible CodeMirror 6 extensions QueryForge would use for a
  query editor), the documented, more faithful alternative is
  `locator.pressSequentially()`, which fires real `keydown`/`keypress`/`keyup` events
  per character, matching how CodeMirror's internal state-tracking actually works.

**TanStack Virtual / virtualized grid testing specifics (Medium confidence, synthesized
from community patterns, not a single official doc):**
- Because TanStack Virtual only renders DOM nodes for currently-visible rows, naive
  locator strategies like counting all rows or asserting on an item far outside the
  current scroll window will fail or mis-count.
- The commonly recommended pattern is to locate rows via a stable `data-index`-style
  attribute tied to the virtualizer's index, treat the **scroll container** (not
  individual rows) as the thing you drive/assert progress against, and **re-resolve
  locators after every scroll step** rather than holding onto element handles, since
  virtualized DOM nodes get recycled/reused for different data rows as you scroll.
  Playwright 1.62+ added a `scroll: 'none'` option on action methods specifically to
  avoid Playwright's own auto-scroll-into-view behavior from fighting a
  test's deliberate virtualized-scroll orchestration.
- TanStack Virtual itself has no built-in "find and jump to row N" API; a test would
  need the app to expose a `scrollToIndex()`-triggering affordance (e.g., a "jump to
  row" UI control or a test-only hook) to reach arbitrary rows deterministically.

---

## Sources

- https://vitest.dev/
- https://www.npmjs.com/package/vitest
- https://github.com/vitest-dev/vitest
- https://jestjs.io/blog
- https://jestjs.io/blog/2022/05/11/jest-joins-openjs
- https://openjsf.org/blog/openjs-foundation-welcomes-jest
- https://engineering.fb.com/2022/05/11/open-source/jest-openjs-foundation/
- https://engineering.fb.com/2017/09/22/web/relicensing-react-jest-flow-and-immutable-js/
- https://security.snyk.io/package/npm/jest
- https://www.13labs.au/compare/jest-vs-vitest (secondary/low-confidence benchmark source)
- https://getautonoma.com/blog/jest-vs-vitest-2026 (secondary/low-confidence benchmark source)
- https://tech-insider.org/vitest-vs-jest-2026/ (secondary/low-confidence benchmark source)
- https://qaskills.sh/blog/vitest-vs-jest-2026 (secondary/low-confidence)
- https://www.electronjs.org/docs/latest/tutorial/automated-testing
- https://www.electronjs.org/docs/latest/development/testing
- https://playwright.dev/docs/api/class-electron
- https://github.com/microsoft/playwright/issues/39477
- https://www.electronjs.org/blog/spectron-deprecation-notice
- https://socket.dev/npm/package/electron-mocha
- https://github.com/jprichardson/electron-mocha/blob/master/CHANGELOG.md
- https://github.com/webdriverio-community/wdio-electron-service
- https://webdriver.io/docs/wdio-electron-service/
- https://webdriver.io/docs/desktop-testing/electron/
- https://www.npmjs.com/package/wdio-electron-service
- https://learn.microsoft.com/en-us/azure/cosmos-db/emulator
- https://devblogs.microsoft.com/cosmosdb/introducing-the-new-linux-based-azure-cosmos-db-emulator-preview/
- https://devblogs.microsoft.com/cosmosdb/announcing-general-availability-of-the-azure-cosmos-db-vnext-emulator/
- https://devblogs.microsoft.com/cosmosdb/azure-cosmos-db-vnext-emulator-query-and-observability-enhancements/
- https://github.com/Azure/azure-cosmos-db-emulator-docker
- https://github.com/Azure/azure-cosmos-db-emulator-docker/discussions/200
- https://github.com/Azure/azure-cosmos-db-emulator-docker/issues/156
- https://github.com/Azure/azure-cosmos-db-emulator-docker/issues/275
- https://github.com/Azure/azure-cosmos-db-emulator-docker/issues/354
- https://docs.azure.cn/en-us/cosmos-db/emulator-linux
- https://learn.microsoft.com/en-us/azure/cosmos-db/free-tier
- https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits
- https://www.junian.dev/tech/microsoft-sql-server-apple-silicon-mac/
- https://devblogs.microsoft.com/azure-sql/development-with-sql-in-containers-on-macos/
- https://www.nocentino.com/posts/2025-11-26-sql-server-2025-docker-desktop-avx-issue/
- https://database.guide/how-to-install-sql-server-on-a-mac-in-2026/
- https://github.com/microsoft/mssql-docker/issues/802
- https://devblogs.microsoft.com/azure-sql/azure-sql-database-container-prpr/
- https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer?view=azuresql
- https://learn.microsoft.com/en-us/azure/azure-sql/database/free-offer-faq?view=azuresql
- https://learn.microsoft.com/en-us/azure/azure-sql/managed-instance/free-offer?view=azuresql
- https://techcommunity.microsoft.com/blog/azuresqlblog/introducing-the-enhanced-azure-sql-database-free-offer-now-generally-available/4372418
- https://github.com/tediousjs/node-mssql
- https://www.npmjs.com/package/testcontainers
- https://github.com/Mu-L/testcontainers-node (mirror; canonical org is testcontainers)
- https://testcontainers.com/modules/cosmodb/
- https://node.testcontainers.org/modules/cosmosdb/
- https://www.npmjs.com/package/@testcontainers/azure-cosmosdb-emulator
- https://devblogs.microsoft.com/ise/testing-with-testcontainers/
- https://www.bytebase.com/blog/top-docker-desktop-alternatives/
- https://usedocker.com/vs/podman
- https://github.com/WiseLibs/better-sqlite3/issues/1111
- https://en.wikipedia.org/wiki/Playwright_(software)
- https://mcr.microsoft.com/en-us/artifact/mar/playwright/about
- https://github.com/examples-hub/electron-tanstack-shadcn
- https://electron-react-boilerplate.js.org/docs/integration-tests
- https://dev.to/nocnica/filling-out-forms-with-playwright-choosing-between-fill-and-presssequentially-3m4d
- https://en.wikipedia.org/wiki/CodeMirror
- https://tanstack.com/virtual/latest
- https://github.com/TanStack/virtual/discussions/481
- https://medium.com/@ulissesbgd/virtual-scrolling-with-playwright-fb741100c8b5
