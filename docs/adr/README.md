# ADR index

One line per decision. "Verified" says what the ADR's own *Status* section claims; open the file for the full list of what is **not** verified live.

## ADR-001…009: no separate files

They are recorded as a table in [docs/ARCHITECTURE.md](../ARCHITECTURE.md) §10 (TypeScript/Node, files as source of truth, built-in SQLite, read-only adapters, panel hooks as fallback, handoff written by a cheap model from deterministic facts, ranges with calibration, sub-agents off by default, scout proposes but never installs). ARCHITECTURE.md §10 says each should become its own file; that has **not** been done.

## ADR-010…026

| ADR | Decision | State of the evidence |
|---|---|---|
| [010](010-single-package-zero-deps.md) | One package, zero runtime dependencies | v0.1 |
| [011](011-json-instead-of-yaml.md) | JSON file formats instead of YAML | v0.1 |
| [012](012-panel-without-react.md) | Panel is plain ES modules, no React, no bundler | v0.1 |
| [013](013-typescript-type-stripping.md) | TypeScript runs through Node type stripping; `tsc` builds for publishing | v0.1 |
| [014](014-hub-commits-only-on-its-own-branches.md) | The hub commits only on `hub/*` branches | v0.1 |
| [015](015-prompt-through-stdin.md) | The prompt goes through stdin, never through arguments | v0.1 |
| [016](016-chat-process.md) | One process per chat message (`--resume`) | decided for now; the spike behind the alternative is unverified |
| [017](017-cascade.md) | Verify-and-escalate cascade | built; fake agent only, no live run |
| [018](018-context-size.md) | A task past 250K tokens of context is stopped and continued from its handoff card | tested with a fake agent; not verified live |
| [019](019-review-gate.md) | Mandatory review gate with verifier votes; only a human approval counts | built; no live reviewer run |
| [020](020-lean-tool-sets.md) | A run starts only the skills and MCP servers its work mode needs | flags observed in `claude --help`; effect on real first-call size not measured |
| [021](021-graph-update.md) | The project graph is built by a bounded `graphify update` the user starts | observed with the real graphify on a small project; large repositories not verified |
| [022](022-starter-kit.md) | Starter kit installs third-party skills into the hub library only, pinned commit, after the user saw every byte | tested with a fake GitHub; no live fetch |
| [023](023-new-project-template.md) | `hub new` works only in a new or empty folder; its verify command stays unapproved | tested; panel flow checked in a browser against the demo server |
| [024](024-run-trace.md) | Run trace and context gauge read per-call `turn` rows: numbers, names, times, bounded | tested; real `stream-json` usage shape not verified |
| [025](025-leftover-limit-scheduler.md) | Using the leftover limit before reset is opt-in, approved jobs only, fails closed | tested incl. real RunManager with a fake agent; CLI window fields unverified |
| [026](026-guardrails-circuit-breaker.md) | The circuit breaker stops runaway runs, ON by default, only the user's config can loosen it | tested; thresholds are defaults, not measured on real runs |

## Not an ADR yet

- The local server's keep-alive window (`server.keepAliveTimeout = 65 s`, `src/server/server.ts`): a test-stability and correctness fix with a regression test (`src/server/keepalive.test.ts`), described in [docs/STATUS.md](../STATUS.md).
