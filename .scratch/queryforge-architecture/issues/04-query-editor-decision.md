Type: grilling
Status: resolved

## Question

Which code editor component should power QueryForge's query editor — Monaco Editor or CodeMirror (product-overview.md §10.3)? Weigh SQL + Cosmos DB NoSQL syntax highlighting support, bundle size/startup cost, autocomplete extensibility (keyword + optional metadata-aware autocomplete per §4.3), and built-in find/replace and formatting support.

~~Note: if the desktop-framework decision (ticket 02) lands on a framework that uses a native OS webview rather than a bundled Chromium runtime (e.g., Tauri), spot-check Monaco's rendering behavior in WebView2 (Windows) and WebKit (macOS) as part of this decision.~~ **Moot** — ticket 02 resolved to Electron, which bundles its own Chromium. No cross-webview rendering variance to check.

## Answer

**CodeMirror 6** (via `@uiw/react-codemirror` / raw `@codemirror/*` packages). MIT-licensed, no fee/license tier for any part used.

Full research: [`research/04-query-editor.md`](../research/04-query-editor.md).

Rationale, confirmed with the user:
- Autocomplete is not a requirement (user confirmed "I do not need code complete") and formatting is a want, not a must — this removes both of CodeMirror's `schemaCompletionSource()` edge *and* Monaco's "batteries included" selling points (minimap, command-palette UI) from consideration, since neither matters now.
- What's left: dialect authoring (Cosmos NoSQL + T-SQL-ish) is comparable effort on either editor (a keyword-list config against an existing SQL grammar skeleton, not a from-scratch parser). Bundle size is plausibly noise against Electron's Chromium baseline either way.
- The deciding factor: Monaco carries a real, recurring, documented Electron-specific integration cost (AMD/ESM loader failing under `file://`, worker-script resolution inside asar packaging) because it's a worker-based architecture (VS Code's language-service model). CodeMirror needs no web workers at all and avoids this entire friction class.
- New global constraint surfaced here: **no fee/licensed components anywhere in the stack.** CodeMirror 6 core and `@codemirror/lang-sql` are MIT-licensed — compatible. Formatting, if added later, should use a free/MIT SQL formatter (e.g. `sql-formatter`), not a paid one. This constraint now applies to every remaining ticket (05 data grid, 06-09) and has been added to the map's Notes.

**Downstream impact:** None of this map's other tickets are blocked by this choice. Flag added to ticket 10's body (Provider Interface / component contracts): don't design the metadata-discovery surface assuming a completion-provider consumer exists for MVP.
