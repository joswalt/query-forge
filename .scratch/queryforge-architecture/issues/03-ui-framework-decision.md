Type: grilling
Status: resolved

## Question

Which UI framework should QueryForge's renderer/frontend use — React with TypeScript (as suggested in product-overview.md §10.2) or an equivalent modern alternative (e.g., Svelte, Vue)? Consider component ecosystem for a DataGrip-style IDE layout (dockable panels, resizable splits), TypeScript support, and compatibility with Monaco/CodeMirror and virtualized data grids.

## Answer

**React with TypeScript.**

Rationale, confirmed with the user: the ecosystem argument is decisive for an IDE-style app this component-dependent. Every piece QueryForge needs has mature, actively-maintained React bindings — Monaco (`@monaco-editor/react`), CodeMirror (`@uiw/react-codemirror`), the leading virtualized grid libraries (AG Grid, TanStack Table), and multiple mature docking/panel-layout libraries for a DataGrip-style shell (`dockview`, `rc-dock`, `react-mosaic`). No pre-existing stack bias made this close; Svelte/Vue would mean weaker or community-only integration for at least one of those pieces.

**Downstream impact:** Data Grid (05) is now unblocked (its other blocker, Desktop Framework, resolved as moot in ticket 02). Query Editor (04) remains independent but can now assume a React host when evaluating `@monaco-editor/react` vs `@uiw/react-codemirror` specifically, rather than the editors' vanilla-JS APIs.
