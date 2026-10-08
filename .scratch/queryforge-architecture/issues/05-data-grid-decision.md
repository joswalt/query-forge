Type: grilling
Blocked by: 02, 03
Status: resolved

## Question

Which virtualized data grid component should QueryForge use for the Results Viewer's table view (product-overview.md §10.4 / §4.5), given the UI framework chosen in ticket 03? Must support large result sets efficiently via virtualized rendering, resizable columns, cell/row selection and copy, and clear NULL-value display.

~~Also blocked by the desktop framework decision (02): ticket 01's research found that a native-OS-webview framework (e.g., Tauri) renders via each platform's own engine (WKWebView/WebView2) rather than one bundled Chromium build, so CSS/layout can differ subtly between macOS and Windows — called out as particularly relevant for grid-heavy UIs. If 02 lands on such a framework, factor cross-platform rendering consistency into the grid library choice.~~ **Moot** — ticket 02 resolved to Electron (single bundled Chromium, no cross-webview variance). The `Blocked by: 02` edge is satisfied now that 02 is resolved; this ticket's real remaining blocker is 03 (UI Framework) only.

## Answer

**TanStack Table + TanStack Virtual** (`@tanstack/react-table` + `@tanstack/react-virtual`). Fully MIT, zero tier gates.

Full research: [`research/05-data-grid.md`](../research/05-data-grid.md).

Rationale, confirmed with the user:
- AG Grid Community was disqualified outright: its entire `ClipboardModule` — covering the spec's exact requirements ("copy individual cells," "copy selected rows," "copy selected values") — is Enterprise-only ($999/dev). Community's only copy path is native browser text-selection, not equivalent.
- MUI X Data Grid Community was a real contender (copy is free; only paste is Premium-gated; ctrl/shift-click multi-select is Pro-only but checkbox-column multi-select works as a free substitute) but was passed over to avoid Material Design styling shaping QueryForge's visual identity, and to avoid any future tier-surprise risk given the usage model may change later (selling/distribution).
- Glide Data Grid was passed over despite built-in clipboard support and strong raw performance, due to mixed maintenance signals (active 2026 releases alongside an open "is this project dead?" issue and a ~90-issue/35-PR backlog) — an open-ended risk versus TanStack's bounded, well-documented hand-build cost.
- TanStack wins on "free forever, no asterisks, no design-system lock-in" — the explicit tradeoff is that clipboard copy, column-resize UI, row-number column, and the virtualized scroll container/sticky headers are all QueryForge-owned code rather than library-provided. NULL-value display and the nested-object/array cell-click JSON inspector are natively supported via TanStack Table's per-column cell render function — no extra mechanism needed for those two.

**Downstream impact:** None of this map's other tickets are blocked by this choice.
