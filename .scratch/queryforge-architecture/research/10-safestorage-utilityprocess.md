# safeStorage availability inside utilityProcess.fork()

## Summary

`safeStorage` is documented and treated by Electron as a **main-process-only** API. It is
**not** available inside a process created via `utilityProcess.fork()`. This has been
explicitly requested by a developer (GitHub issue electron/electron#42869, "Make
`safeStorage` available in the utility process") and the request was **closed as not
planned** — i.e., Electron maintainers did not add it. There is no documented way to call
`safeStorage` directly from a utility process; the only established pattern is to keep
`safeStorage` calls in the main process and transport the resulting plaintext to the
utility process over IPC/MessagePort at the moment it's needed.

## Direct answer

**No — `safeStorage` is not accessible from inside a `utilityProcess.fork()`-spawned
process.** It must be called from Electron's main process.

## Findings by sub-question

**1. What API surface is available inside a utility process?**
Electron's docs describe the utility process as running "a child process with Node.js and
Message ports enabled" — i.e. a full Node.js environment (`require`, all Node APIs) plus
`process.parentPort` for messaging with the parent. Electron itself uses a convention where
every API reference page has a `Process:` designator at the top (e.g. `net`'s page states
`Process: Main, Utility`, meaning it's explicitly usable in both). Only modules whose docs
carry `Utility` in that designator are usable there (e.g. `net`). The `utility-process.md`
page and the `tutorial/process-model` overview do not provide a single master list of every
module usable in utility processes — this must be checked module-by-module via each
module's `Process:` line.

**2. What does `safeStorage`'s doc say about which process it must run in?**
The `safeStorage` page's `Process:` designator reads **"Main"** only — there is no mention
of "Utility" anywhere on that page. No sandboxed-renderer or utility-process support is
mentioned. The documented restrictions are:
- Several methods behave differently or return `"unknown"`/`false` before the main
  process's `app` has emitted its `ready` event (e.g. `isEncryptionAvailable()`,
  `getSelectedStorageBackend()`).
- On macOS/Linux, calls can block the current thread waiting on Keychain/secret-store user
  input.
- App should be code-signed on macOS for consistent behavior.
There is no restriction language framed as "cannot be called from utility process"
verbatim — the restriction is implicit in the `Process: Main` designator, which is
Electron's standard way of scoping an API to a single process type.

**3. Is "decrypt in main, pass plaintext to utility process via IPC" a documented/recommended pattern?**
Electron's own docs do not provide a worked example of this exact pattern for
`safeStorage` + `utilityProcess`. However:
- It is the **de facto workaround** reported by developers who hit the same wall: the
  GitHub issue requesting native utility-process `safeStorage` support explicitly cites
  the inconvenience of "hav[ing] to set up IPC to root [main] to use the `safeStorage`
  module" as the reason for the request — implying this IPC-proxy pattern is the only
  option today, and is already in use in real projects.
- Electron explicitly supports `MessagePortMain`/`child.postMessage()` as the sanctioned
  channel for main↔utility communication, which is the mechanism such a proxy would use.
- No official Electron doc flags or warns about the "plaintext credential now traveling
  over an IPC channel" concern — that risk is not addressed by Electron's documentation at
  all; it would be a project-level judgment call, not something Electron has pre-approved
  or warned against.

**4. Can `safeStorage.decryptString` actually be called directly from a utility process (non-issue)?**
No evidence this works, and direct evidence it doesn't: the feature-request issue to make
`safeStorage` available in utility processes exists precisely because it currently is not,
and that issue was closed as "not planned" rather than resolved by adding support. There is
no alternate accessor, flag, or option documented to enable `safeStorage` outside the main
process.

## Sources

- https://www.electronjs.org/docs/latest/api/safe-storage — `Process: Main` designator;
  full method list (`isEncryptionAvailable`, `isAsyncEncryptionAvailable`,
  `encryptString`, `decryptString`, `encryptStringAsync`, `decryptStringAsync`,
  `setUsePlainTextEncryption`, `getSelectedStorageBackend`); platform notes on `ready`
  event timing, Keychain blocking, and macOS code-signing.
- https://www.electronjs.org/docs/latest/api/utility-process — utility process description
  ("child process with Node.js and Message ports enabled"), `process.parentPort`,
  `utilityProcess.fork()` can only be called after `app` `ready`, stdio/macOS flag notes.
- https://www.electronjs.org/docs/latest/api/net — contrast example showing `Process:
  Main, Utility` designator for a module that IS available in utility processes.
- https://www.electronjs.org/docs/latest/tutorial/process-model — general utility-process
  description ("runs in a Node.js environment... require modules and use all of Node.js
  APIs"); confirms no master cross-module availability table exists outside per-module
  `Process:` lines.
- https://github.com/electron/electron/issues/42869 — "Make `safeStorage` available in the
  utility process," opened because "Its inconvenient for us to have to set up IPC to root
  to use the `safeStorage` module," closed as **not planned** — direct evidence the gap is
  real, known to Electron's own issue tracker, and unresolved.
