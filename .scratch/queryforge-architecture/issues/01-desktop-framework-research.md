Type: research
Status: resolved

## Question

What are the practical runtime-compatibility constraints for QueryForge's desktop framework choice (Electron vs Tauri vs other credible cross-platform options), specifically:

- Can the official Azure Cosmos DB SDK and the Microsoft SQL Server Node.js driver (`mssql`/`tedious`) run directly in the framework's backend process, or does the framework force a different runtime (e.g., Tauri's Rust core has no official Cosmos DB SDK)?
- What's the maturity of OS-native credential store integration (macOS Keychain, Windows Credential Manager) for each framework (e.g., `keytar`/Electron `safeStorage` vs Tauri's keyring/stronghold plugins)?
- What's the maturity of embedded SQLite support for each framework (e.g., `better-sqlite3` vs Tauri's SQL plugin/`rusqlite`)?
- What's the current packaging/installer maturity for macOS (Apple Silicon + Intel) and Windows for each framework, including code-signing support?
- Any other material differences in bundle size, startup time, or memory footprint relevant to a query/data exploration tool.

Scope: cover Electron and Tauri at minimum. Only cover another option (e.g., Wails, NeutralinoJS) if it's a genuinely credible contender for this app — skip a deep dive on options nobody would plausibly pick.

## Answer

Full findings: [`research/01-desktop-framework.md`](../research/01-desktop-framework.md).

Gist: Electron runs `@azure/cosmos`/`mssql` unmodified in its Node main process — no native bindings, no ABI story. Tauri has no Node runtime, so it needs either (a) Rust-native Azure clients — Cosmos DB's official crate is pre-1.0/beta, and the Azure SQL driver (`tiberius`) is reported unmaintained with open security advisories — or (b) a Node sidecar process, which restores JS SDK support but adds an estimated +40-80MB and an extra per-architecture packaging step (Tauri's own recommended sidecar-build tool, `pkg`, is deprecated). Credential storage, SQLite, and OS-mandated signing/notarization are all mature on both sides, just shaped differently (Electron: blob-encryption primitive + build-your-own named-credential layer; Tauri: `keyring`-crate-backed plugins give named-entry semantics more directly, but the plugin wrappers are newer/thinner). Multi-window is stable in Electron, experimental in Tauri. Bundle-size/memory favor Tauri in most sources, but the one methodology-disclosed benchmark found Electron cold-starting faster, contradicting the marketing consensus — flagged low-to-medium confidence. Wails (Go) surfaced as a credible third option with its own official Azure SDKs, at the cost of introducing a third language ecosystem.

No recommendation made — this is fact-finding for ticket 02 (Desktop Framework decision) to weigh.
