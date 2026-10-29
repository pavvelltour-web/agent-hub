# Contributing

Thanks for looking. The rules for every coding agent and person who works here are in [AGENTS.md](AGENTS.md); this page is the short version.

## Set up

Requirements: Node 24 or newer, git, pnpm 9. Windows is the first-class platform.

```bash
pnpm install --frozen-lockfile
node bin/hub.js ui --demo          # the panel with scripted fake agents; prints the URL with a token
```

## Before you open a pull request

```bash
node scripts/test-all.mjs          # all tests folder by folder, typecheck, security, diagrams; writes test-report.md
```

All of it must be green. A single `pnpm test` runs the same tests in one process and takes over 10 minutes. Individual folders: `node scripts/test-all.mjs --only run,core`.

## Rules that are easy to break

- **Zero runtime dependencies**, one package. A new dependency needs an ADR in `docs/adr/` and the owner's OK.
- TypeScript strict, ESM, imports with the `.ts` extension, **erasable syntax only** (no enums, parameter properties, namespaces): Node runs the `.ts` files directly.
- Tests are `node:test` files next to the code (`*.test.ts`). Write the failing test first. Add negative cases for paths, branch names and secrets.
- Do not weaken or delete an assertion to make a test pass; find the cause.
- Text that an agent reads (rules, templates, prompts, the tool catalog) is **English**; the panel's own texts are Russian. A test fails on Cyrillic in the agent-facing files.
- The panel is plain ES modules in `web/`. Build DOM with `h()` or `textContent`, never `innerHTML` with data. Colors only from `design/tokens.css`. Check four themes and a 375 px width.
- Never read, print or commit credential files (`auth.json`, `.credentials.json`, anything under `secrets/`). The security check scans for them.
- Anything that spawns a process, touches git on an agent's branch, or writes outside a project root is a security boundary and needs a careful review of the diff.
- Update the docs with the change: `docs/STATUS.md` (say what was observed and what was not), the ADR index, and the diagrams (`node bin/hub.js diagram arch --write`).

## Reporting problems

Bugs and ideas: open an issue. Security problems: see [SECURITY.md](SECURITY.md).
