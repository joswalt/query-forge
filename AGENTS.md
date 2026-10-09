# QueryForge; agent notes

## Running node/npm

The agent Bash tool's shell has no `node`/`npm` on PATH (`command not found: npm`), even though `~/.zshenv` is meant to add a default node. Don't hardcode a node version path. Load nvm first in the same command:

```sh
source ~/.nvm/nvm.sh && npm test
```

nvm's default is v24.12.0. The `jenv: command not found` lines printed by shell init are harmless noise.

## Commands

- `npm run typecheck` / `npm test`; both must pass before declaring work done.
- `npm run rebuild:electron`; needed before `npm run dev`/`build` (see README.md); plain `npm test` uses the Node-ABI `better-sqlite3`.

## Project context

- Locked implementation spec: `.scratch/queryforge-architecture/spec.md`.
- Domain vocabulary: `GLOSSARY.md` (use these terms in identifiers and test names).
- Credential-handoff design: `docs/adr/0001-decrypt-credentials-in-main-pass-plaintext-to-utility-process.md`; don't "fix" the main→utilityProcess plaintext transit.
