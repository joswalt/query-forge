# Research: Data Grid / Results Table Library

## Summary

Of the two "batteries-included" commercial-style grids evaluated, both have a free/MIT tier that is narrower than it first appears for this app's exact requirement list. **AG Grid Community (MIT)** gives virtualization, column resizing, and scrolling for free, but its *entire* clipboard module — including plain Ctrl+C copy of a selected cell/row without manually highlighting text — is Enterprise-only (commercial, $999/developer); Community's only copy path is the browser's native text-selection copy, which is not equivalent to "copy selected rows"/"copy selected values" as the spec describes them. **MUI X Data Grid**'s split is more favorable but still has a gate relevant here: clipboard **copy** is free in Community, but ctrl/shift-click **multi-row selection** (needed for "copy selected rows") requires Pro, and clipboard **paste** requires Premium (not needed per spec, but confirms the tiering pattern). **TanStack Table + TanStack Virtual** is fully MIT/headless with no tier at all — every requirement is buildable, but clipboard copy, NULL-cell rendering, row numbers, and resize handles are all hand-built rather than provided. **Glide Data Grid** is fully MIT, canvas-based, has an explicit (if slightly manual) clipboard API, and a strong large-dataset performance reputation, but shows some 2025-2026 community concern about maintenance pace (an open "is this project dead?" issue, backlog of ~90 open issues/35 open PRs) alongside continued point releases. `react-window`/`react-virtualized` are noted as lower-level MIT primitives other libraries (including TanStack Virtual's competitors) are built on, not grid solutions themselves.

## 1. AG Grid Community

**License (confidence: high).** `ag-grid-community` is MIT-licensed, free for everyone including production use, no license key required. `ag-grid-enterprise` requires a separate commercial license ($999/developer, perpetual with 1 year of updates/support; volume pricing scales from there) and is "free to test locally" but requires a paid license for production use.

**What's in Community (confidence: high, from AG Grid's own community-vs-enterprise and clipboard docs):**
- Column and row virtualization — enabled by default, explicitly listed as a Community performance feature. Confirmed adequate for "thousands of rows."
- Column resizing, sorting, filtering, pagination, cell rendering/editing, custom cell components (usable as the hook for a JSON-detail-inspector), themes, accessibility — all Community.
- Row numbers: achievable via a custom/pinned column in Community (not a licensed feature either way).
- Horizontal/vertical scrolling: Community.

**What's gated behind Enterprise (confidence: high — confirmed directly from AG Grid's own `/javascript-data-grid/clipboard/` doc, not a third party):**
- The entire `ClipboardModule`, imported only from `ag-grid-enterprise`, covers: Ctrl+C copy of a focused cell, copying multi-cell ranges, copying selected rows (`rowSelection.copySelectedRows`), copying column headers, cut (Ctrl+X), and paste. All of these are stated in AG Grid's own docs as "enabled by default for enterprise users" — i.e., not present at all without an Enterprise license.
- Community's only copy mechanism is `enableCellTextSelection` (explicitly called out as "not an enterprise config"), which lets a user manually highlight text inside one cell and use the **browser's own** native copy — not an AG-Grid-provided "copy cell/row/selection" action, and not multi-cell/multi-row in nature. AG Grid's own sample code for Community literally notes "the context menu is not available to copy the focused cell value" in that edition.
- Cell range/selection ("select and manipulate ranges of data") is also an Enterprise-listed feature in AG Grid's own feature table, separate from clipboard.

**Flag for this project:** three of the spec's explicit requirements — "copy individual cells," "copy selected rows," "copy selected values" — map directly onto AG Grid's Enterprise-only `ClipboardModule`. This is not a minor edge case; it is the specific feature named in the product spec, and AG Grid Community alone cannot satisfy it without hand-building an entirely separate, non-AG-Grid clipboard layer on top (reading grid state and writing to `navigator.clipboard` manually) — at which point much of AG Grid's "batteries-included" value for this requirement specifically is not being used.

## 2. TanStack Table + TanStack Virtual

**License (confidence: high).** Both `@tanstack/react-table` and `@tanstack/react-virtual` are MIT-licensed, maintained by TanStack (Tanner Linsley), with no paid tier, Enterprise edition, or feature gate of any kind — the entire project is open-source.

**Headless nature and what has to be hand-built (confidence: high, consistent with the libraries' own documented design and with searches finding no official clipboard examples):**
- TanStack Table provides state/logic (sorting, column sizing/resize state, row models, row selection state) but renders *nothing* — all markup (table/thead/tbody/td, resize-handle drag UI, row-number column, NULL-value styling) is application code.
- TanStack Virtual provides the virtualization primitive (`useVirtualizer`, tracks visible window, returns indices/offsets to render) for both rows and, with a second virtualizer instance, columns — but again supplies no DOM/UI; the scrolling container, sticky headers, etc. are hand-assembled.
- Column resize: TanStack Table exposes resize *state and handlers* (`column.getResizeHandler()`, `header.getSize()`) but the actual resize-handle element and its drag behavior/visual feedback must be built by the app.
- Clipboard copy (individual cell / selected rows / selected values): no official TanStack example or built-in API was found for this. The standard pattern is to read `table.getSelectedRowModel()` or cell values and call `navigator.clipboard.writeText()` manually — this is pure application code, not a TanStack feature at any tier (not a license gate, just "not provided").
- NULL-value display and nested-object/array cell-click detail inspector: both are trivial to add since TanStack Table's `cell` render function is just a custom React render callback per column — this is the "custom cell-click/cell-renderer hook" the spec asks for, and it's native to how the library already works (not a bolted-on feature).
- Row numbers: a synthetic column with `row.index`, hand-added.

**Net assessment:** every requirement is achievable, with zero licensing risk at any feature level, but the amount of UI and interaction code QueryForge would own is substantially larger than with AG Grid or MUI X — column-resize drag UX, clipboard copy, row-number column, and the virtualized scroll container/sticky-header wiring are all first-party QueryForge code rather than library-provided behavior. This is the direct trade for having no tier gate anywhere.

## 3. Glide Data Grid (`@glideapps/glide-data-grid`)

**License (confidence: high).** MIT License (confirmed directly from the repository's `LICENSE` file, copyright Glide/typeguard, Inc.). Fully free for commercial use, no Enterprise tier exists for this library at all.

**Architecture and performance reputation (confidence: medium-high — vendor/community sources agree directionally, exact numbers are marketing-adjacent).** Canvas-based rendering rather than DOM-per-cell; the project's own FAQ states this was a deliberate pivot away from an earlier DOM-virtualized (react-virtualized-based) implementation specifically because loading/unloading hundreds of DOM elements per scroll frame couldn't deliver smooth scrolling. Independent write-ups and the project's own claims describe it as handling "millions of rows" at 60fps with lazy on-demand cell rendering, versus other libraries' DOM-based approaches reportedly showing degradation in the 10,000–100,000-row range. For QueryForge's stated scale ("could be thousands of rows"), this is comfortably within its designed-for range on any telling of these numbers; we did not find an independent, methodology-disclosed benchmark (all performance claims traced back to vendor/blog sources), so treat the specific fps/row-count figures as directional, not verified.

**Clipboard support (confidence: high, from official API docs/quickstart):** Copy is not automatic — the app must implement `getCellsForSelection` (returns selected cells in row-major order); without it, copy does not work. Ctrl/Cmd+C copies the current selection, Ctrl/Cmd+V pastes. Paste can be enabled trivially (`onPaste={true}` once `onCellEdited` exists) or handled with a custom callback. One documented gap: custom (non-built-in) cell kinds need an explicit `copyData` property added in `getCellContent`, or `getCellsForSelection`'s default behavior won't pick them up — a real but well-documented and solvable integration detail, not a license gate. Paste across multiple selected columns is noted as an open limitation (GitHub issue), not relevant to QueryForge's copy-only requirement.

**NULL display / custom cell-renderer hook (confidence: medium, inferred from documented cell-kind architecture):** Glide Data Grid's cell model is kind-based (text, number, markdown, bubble, image, drilldown, uri, and custom kinds), with `getCellContent` as the per-cell render hook — this is the mechanism that would support both a clear NULL rendering (e.g., a distinct "null" cell kind/styling) and a click-to-expand hook for nested JSON (e.g., via the `drilldown` cell kind or a custom kind wired to open a detail inspector on click). We did not find an official example specifically combining "click cell → open external inspector," so this is a reasonable architectural inference from the documented API rather than a confirmed example.

**Maintenance status (confidence: medium — mixed, directly conflicting signals found).** On one hand: continued dated releases through 2026 (6.0.x series with fixes), ~5.3k GitHub stars, 419 forks, substantial weekly npm downloads (tens of thousands to ~290K depending on source/snapshot), and production users (e.g., Streamlit depends on it, with an upstream-fix update merged in 2025). On the other hand: an open GitHub issue literally titled "Is this project dead?" (opened Jul 2026), a backlog of roughly 92 open issues and 35 open PRs, at least one downstream consumer reporting a 2024 maintenance lapse that led them to maintain a private fork, and an unresolved question about why a 6.0.4 release exists but hasn't been promoted to stable (raised May 2026). **Net: actively used and still receiving releases, but maintenance velocity is a legitimate open question a human should weigh, not a settled "actively maintained" green light.**

## 4. MUI X Data Grid

**License/tiering (confidence: high, from MUI's own licensing and feature pages).** Open-core model: Community (`DataGrid`) is MIT, "free forever" per MUI's own statement, and unaffected by MUI's April 2026 Pro/Premium pricing and licensing changes (those changes affect only Pro/Premium pricing structure and application-based licensing, not the Community feature set or its license). Pro and Premium require paid commercial licenses (Pro ~$299/developer/year, Premium ~$599/developer/year per third-party pricing trackers — not confirmed on MUI's own pricing page in this research).

**Feature-by-feature findings relevant to this project's requirements (confidence: high for items confirmed directly on MUI's own docs pages):**
- **Column resizing: Community.** Confirmed directly on MUI's column-dimensions doc: resizing is on by default for all columns in the free `DataGrid`, not gated.
- **Clipboard copy: Community.** Confirmed on MUI's own clipboard doc page — the "Clipboard copy" section carries no plan-restriction tag, unlike the adjacent "Clipboard paste" section (tagged Premium). This directly contradicts the commonly-repeated claim that "MUI X gates clipboard behind Pro" — **copy specifically is free; only paste is Premium-gated.** This is the one item the task asked to double-check precisely, and the finding is: copy is not restricted, paste is.
- **Clipboard paste: Premium.** Not required by QueryForge's spec (no paste/edit requirement stated), so this gate is not a blocker here, but worth flagging since it's commonly conflated with copy.
- **Row selection: split.** Single-row selection and checkbox-column selection work in Community by default. Multi-row selection via Ctrl/Shift-click, and the row-range selection API (`selectRowRange`, `selectRows`), are Pro/Premium-only per MUI's own row-selection doc. QueryForge's "copy selected rows" requirement implies multi-row selection, which pushes this specific requirement into Pro territory unless QueryForge builds its own multi-select state on top of Community's single/checkbox primitives (feasible, since checkbox-column multi-select *is* available in Community — the gate is specifically on ctrl/shift-click range-style multi-select, not all forms of selecting more than one row).
- **Virtualization: Community** (not explicitly tier-gated in any source found; MUI's row/column virtualization is part of the base `DataGrid` and is standard practice for this library at any tier).
- **Row numbers:** not explicitly documented as tiered either way; typically implemented via a pinned/custom column, which Community supports.

**Net:** MUI X Community's gate is narrower and more targeted than AG Grid's — copy itself is free, and the real friction is multi-row (ctrl/shift-click) selection, which is Pro-only unless QueryForge instead builds multi-select on the free checkbox-column mechanism.

## 5. Other credible free contenders

- **`react-window`** (MIT): mature, lightweight (~2KB), actively used as a virtualization *primitive* (not a grid), but its maintainer has stated it's feature-frozen — no dynamic sizing support is planned. Usable as a foundation for a hand-rolled grid (as TanStack Table apps sometimes do), but more boilerplate-heavy for sticky headers/columns than `@tanstack/react-virtual`, per community comparisons.
- **`react-virtualized`** (MIT): the same author's earlier, larger library; explicitly in maintenance mode, and its own npm page recommends `react-window` instead for new projects. Not a credible primary choice for a new 2026 build.
- Neither of these is a complete "grid" in the sense AG Grid/MUI X/Glide are — they would only be relevant if QueryForge builds a fully custom grid on top of TanStack Table (in which case TanStack Virtual, not react-window, is the more current pairing already covered in §2).

## Sources

Search and fetch performed live (WebSearch/WebFetch tools), October 2026. Key sources:

- [AG Grid — JavaScript Grid: Community vs. Enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/)
- [AG Grid — JavaScript Grid: Clipboard](https://www.ag-grid.com/javascript-data-grid/clipboard/) (official doc confirming Community's only copy path is `enableCellTextSelection`/native browser copy, and that `ClipboardModule` is `ag-grid-enterprise`-only)
- [AG Grid — Licence and Pricing](https://www.ag-grid.com/license-pricing/)
- [ag-grid-community on npm](https://www.npmjs.com/package/ag-grid-community) (MIT license confirmation)
- [AG Grid Enterprise landing page](https://www.ag-grid.com/landing-pages/enterprise-data-grid/)
- [AG Grid Software Pricing & Plans 2026 — Vendr](https://www.vendr.com/marketplace/ag-grid)
- [AG Grid Enterprise License Cost 2026 — Simple Table blog](https://www.simple-table.com/blog/ag-grid-pricing-license-breakdown-2026)
- [TanStack Table — Row Selection guide](https://tanstack.com/table/v8/docs/guide/row-selection)
- [TanStack Table — React Virtualized Rows example](https://tanstack.com/table/v8/docs/framework/react/examples/virtualized-rows)
- [Glide Data Grid — GitHub repository](https://github.com/glideapps/glide-data-grid)
- [Glide Data Grid — LICENSE file (MIT)](https://github.com/glideapps/glide-data-grid/blob/main/LICENSE)
- [Glide Data Grid — API.md](https://github.com/glideapps/glide-data-grid/blob/main/packages/core/API.md) (`getCellsForSelection`, `onPaste` documentation)
- [Glide Data Grid — Copy and paste support (quickstart docs)](https://docs.grid.glideapps.com/extended-quickstart-guide/copy-and-paste-support)
- [Glide Data Grid — "Is this project dead?" issue #1195](https://github.com/glideapps/glide-data-grid/issues) (maintenance-concern discussion surfaced via search)
- [Glide Data Grid — Releases](https://github.com/glideapps/glide-data-grid/releases)
- [npm trends — @glideapps/glide-data-grid](https://npmtrends.com/@glideapps/glide-data-grid)
- [MUI X — Licensing](https://mui.com/x/introduction/licensing/)
- [MUI X — Data Grid: Copy and paste (clipboard) docs](https://mui.com/x/react-data-grid/clipboard/)
- [MUI X — Data Grid: Column dimensions (resizing) docs](https://mui.com/x/react-data-grid/column-dimensions/)
- [MUI X — Data Grid: Row selection docs](https://mui.com/x/react-data-grid/row-selection/)
- [MUI X — Data Grid feature showcase](https://mui.com/x/react-data-grid/features/)
- [MUI — Upcoming Changes to MUI X Pricing and Licensing in 2026 (blog)](https://mui.com/blog/2026-mui-x-price-changes/)
- [react-window vs react-virtualized maintenance status — LogRocket / community comparisons](https://blog.logrocket.com/react-virtualized-vs-react-window/)
- [react-virtualized on npm](https://www.npmjs.com/package/react-virtualized)

**Confidence notes:** License identities (MIT for AG Grid Community, TanStack, Glide Data Grid, MUI X Community; commercial for AG Grid Enterprise and MUI X Pro/Premium) are **high confidence**, sourced from the projects' own license files/docs. The precise clipboard tiering for AG Grid (fully Enterprise-gated, with only native-browser text-selection copy in Community) and for MUI X (copy free, paste Premium, multi-row ctrl/shift-click selection Pro) are **high confidence**, both fetched directly from each vendor's own current documentation pages rather than third-party summaries. Performance claims for Glide Data Grid (millions of rows, 60fps) are **medium confidence** — vendor/community-sourced, not independently benchmarked in this research. Glide Data Grid's maintenance trajectory is **medium confidence** and explicitly mixed-signal (active releases and production users vs. an open "is this dead?" issue and backlog) — a human should look at the repo's commit history directly before relying on it. MUI X Pro/Premium exact pricing figures are **low-to-medium confidence**, sourced from third-party pricing trackers rather than confirmed on MUI's own pricing page in this research.
