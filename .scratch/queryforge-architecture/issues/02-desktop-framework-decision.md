Type: grilling
Blocked by: 01
Status: resolved

## Question

Which desktop application framework should QueryForge use (Electron vs Tauri vs another cross-platform option), given the findings from the desktop-framework research ticket (01)? This decision gates Driver Strategy (06), Local Persistence (07), Auth/Credential Storage (08), and Distribution/Packaging (09) — treat it as the highest-leverage call on this map.

**Must verify before deciding** — ticket 01 flagged these as unverified, not just unresolved preference:
- Whether `azure_data_cosmos` (the official pre-1.0 Rust Cosmos DB crate) actually covers cross-partition query execution, continuation-token paging, per-request RU-charge reporting, and container/index-policy enumeration — ticket 01 only skimmed docs, didn't verify hands-on. Only matters if Tauri + Rust-native clients (Option A) is in play.
- The claim that Go's official Azure SDKs (Cosmos DB + `go-mssqldb`) are more mature than the Rust equivalents — asserted from general knowledge in ticket 01, not searched. Only matters if Wails is a live contender.
Dispatch a quick fact-finding sub-agent for whichever of these is still load-bearing once the frontrunner(s) narrow, rather than deciding on the unverified claim.

## Answer

**Electron.**

Rationale, confirmed with the user:
- SDK stability and single-language simplicity outweigh Tauri's bundle/memory advantage. `@azure/cosmos` and `mssql`/`tedious` run unmodified in Electron's Node main process; Tauri would require either a pre-1.0/beta Rust Cosmos DB crate plus an unmaintained Azure SQL driver (`tiberius`), or a Node sidecar that claws back most of the size advantage and adds a per-architecture packaging step.
- Multi-window is not a requirement — QueryForge's MVP uses tabs within one window (per the §5 wireframe), so Electron's stable multi-window support vs. Tauri's experimental support isn't a factor either way, but removes a reason to prefer Tauri.
- Wails (Go) is dropped without further fact-checking — smallest ecosystem of the three, and introducing a third language with no team experience isn't worth it when Electron already satisfies the SDK requirement at zero risk.
- Both facts flagged as unverified in this ticket (Rust Cosmos crate query-surface completeness; Go SDK maturity) are now moot — neither Tauri's Rust-native path nor Wails is in play.

**Downstream impact:** Driver Strategy (06), Local Persistence (07), Auth/Credential Storage (08), and Distribution/Packaging (09) are now unblocked and should assume Electron as the framework. Ticket 04 (Query Editor)'s conditional note about spot-checking Monaco in a native OS webview no longer applies — Electron bundles its own Chromium, so there's no cross-webview rendering variance to check. Ticket 05 (Data Grid)'s concern about native-webview rendering inconsistency across macOS/Windows is similarly moot now that Electron is chosen; ticket 05 remains blocked by 03 (UI Framework) in practice.
