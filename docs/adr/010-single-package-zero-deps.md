# ADR-010: one package, zero runtime dependencies

Context: PLAN proposed a pnpm monorepo (core, cli, server, web, adapters) with Hono and React.
Decision: v1 is one package. Server is `node:http`, storage is `node:sqlite`, TypeScript is run by Node itself, tests use `node:test`. Only `typescript` and `@types/node` are dev dependencies.
Why: `npx agent-hub` installs in seconds; nothing to audit at runtime (`pnpm audit` is trivially clean); no native modules on Windows.
Consequences: splitting into packages later is a mechanical move (folders already match). Rejected: Hono (saves ~100 lines, adds a dependency), better-sqlite3 (native build on Windows).
