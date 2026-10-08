Type: grilling
Blocked by: 02
Status: resolved

## Question

What installer/packaging and distribution approach should QueryForge use for macOS (Apple Silicon + Intel) and Windows (product-overview.md §10.8), given the desktop framework chosen in ticket 02? Cover code-signing/notarization strategy, auto-update mechanism (if any for MVP), and how the existing branding assets (`.docs/queryforge-assets` — icons, `.iconset`, light/dark logos, `.ico` files) map onto each platform's packaging requirements.

**Scope note (surfaced while resolving ticket 04):** current usage model is local-only — no app-store submission, no selling, no CI pipeline, may change later. Code-signing/notarization isn't a hard requirement for this goal (an unsigned local build is acceptable for now); frame the answer as "minimum viable local packaging now" plus what to revisit if/when distribution to others becomes a goal.

## Answer

**electron-builder**, producing **unsigned local builds for now**: macOS `.dmg`/`.zip` via the `mac` target, Windows NSIS/portable `.exe` via the `win` target. No Apple notarization, no Windows code-signing certificate, no auto-update wiring. Branding assets (`.docs/queryforge-assets`) map directly onto electron-builder's `mac.icon`/`win.icon` config as-is.

Rationale, confirmed with the user:
- electron-builder chosen over electron-forge (both MIT) because it already has signing/notarization config and built-in auto-update (`electron-updater`) ready to flip on later without switching packaging tools when the usage model changes, and has a larger community to lean on as a solo dev.
- Unsigned local builds confirmed as sufficient — matches the standing "local-only for now, may change later" constraint (map Notes). Gatekeeper/SmartScreen "unknown developer" warnings are an accepted, bypassable cost (right-click → Open on macOS; "Run anyway" on Windows) rather than a reason to set up a $99/yr Apple Developer account or a Windows signing cert for an app that isn't leaving the user's machine.
- Explicitly deferred, not decided against: code-signing, notarization, and auto-update. Revisit if/when distribution to others (store submission, selling) becomes a real goal — the tool choice (electron-builder) was made specifically so that revisit doesn't require a migration.

**Downstream impact:** None of this map's other tickets are blocked by this choice.
