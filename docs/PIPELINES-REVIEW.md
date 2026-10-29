# Pipelines: short review (2026-10-28)

Statuses: **observed** = ran or read it in this session · **inferred** = reasoned from code or docs, not run · **proposed** = not done.
Basis: reading `src/run/runner.ts`, `ci.yml`, `package.json`, `pnpm-lock.yaml`, the mode and registry files; the per-folder test run (731 pass); the keep-alive investigation in [STATUS.md](STATUS.md). No pipeline was run against a signed-in Claude or Codex CLI.

| # | Pipeline | What it does | Verdict |
|---|---|---|---|
| 1 | **Run** (`hub run`, chat, panel) | request → guard (circuit breaker, max 4 live runs) → worktree on `hub/<task>/<agent>` → adapter spawns the CLI, prompt through stdin → events normalised, redacted, stored, streamed (SSE) → outcome, tokens, cost | Sound. Tests green (observed). Weak spot found and fixed: the server blocks its event loop on synchronous git, which broke keep-alive sockets (observed, fixed). The stall itself remains (inferred risk) |
| 2 | **Handoff** | limit or 250K context → checkpoint commit on a `hub/*` branch → card (git facts + model summary, deterministic fallback) → continue on the other agent in the same folder | Sound by tests with fake agents (observed). The model-written summary was **never run live** |
| 3 | **Cascade** (ADR-017) | approved verify command → run → verify in a clean copy of the commit → escalate or solve | Trust boundary was attacked twice and fixed (STATUS). **No live run**; success rate unknown |
| 4 | **Review gate** (ADR-019) | approved checks (digest-pinned) → reviewers → verifiers → human approval | Sound by tests. **No live reviewer run**; recall and noise on real models unknown |
| 5 | **History import** | `~/.claude` and `~/.codex` read-only → redact → SQLite index | Observed on the real machine in v0.1 (441 Codex threads in 18 s). Sub-agent sessions are **not** imported for Claude |
| 6 | **Install / wizard / starter kit** | plan → approval → backup → apply → undo | Tested with a fake GitHub (observed); no live fetch |
| 7 | **Scheduler and breaker** | opt-in use of the leftover limit; caps and stop | Tested with the real RunManager and a fake agent; CLI window fields unverified |
| 8 | **Lifecycle stages** | 8 stages, each closed by its files and your approval | Works as described; `stages/stages.json` is Russian (see findings) |
| 9 | **Docs and graph** | manual: `graphify update .`, `diagram --check`, STATUS by hand | Works, but manual: Markdown is not re-extracted without an LLM and community labels go stale (observed on 2026-10-28) |
| 10 | **CI** (`.github/workflows/ci.yml`) | windows-latest, Node 24, pnpm, typecheck, **whole** test suite, security, build | Consistent with `package.json` and the lock file (scripts exist, specifiers match; observed by reading). **Never run** (no remote yet). Expect trouble: see F1 |

## Findings

- **F1 (CI, proposed).** The workflow runs `pnpm test`, the whole suite in one command, which here takes over 10 minutes and was only reliable per folder. The file still says "Not active until the repository is published". Proposal: one job per folder, or `--test-concurrency=2`; fix the comment when publishing. **Update 2026-10-29:** `ci.yml` now has a `checks` job and one `test` job per folder (13 jobs) using `scripts/test-all.mjs`; a test pins the folder list. **Still never run on GitHub**: the first run is step H6 of `docs/TEST-PLAN.md`.
- **F2 (language, observed; fixed on 2026-10-28, ADR-027).** Agent-facing texts that are Russian: `stages/stages.json`, 12 of 20 files in `templates/` (`brief.md`, `docs/architecture.md`, `REVIEW.md` per project type), and the `why` field of every starter-kit skill (shown to the person). Mode titles and hints are Russian too (they are UI text); their `promptPrefix` is English. The tool catalog (`registry/entries/catalog.json`: id, title, description) is already English.
- **F3 (sub-agents, observed; partly fixed on 2026-10-28, ADR-027: the map shows them, their context is still not measured).** The hub has no entity for a sub-agent. It ignores their token usage (`parent_tool_use_id`), does not import Claude sidechains, and the live chat only nests their tool calls. Nothing can be mapped or messaged per sub-agent today. See the design in `docs/superpowers/specs/`.
- **F4 (wall-clock test, observed).** `trace-review-api.test.ts` "the skills estimate never makes a request wait" asserts a time limit and failed once under load.
- **F5 (docs, observed).** ADR-001…009 exist only as a table in ARCHITECTURE.md. STATUS.md says nothing is published; it must be updated when that changes.

## Modes and "training" (what exists)

- **Mode choice (observed in the running panel):** the Today screen offers Chat, Task in a branch, Interview, Autopilot, Review (`modes/*.json`); Chat is the normal mode (edit permission, no worktree). Autopilot needs the `autopilot` skill and refuses with the exact command otherwise.
- **Teaching agents (the user: "rules by mode, and skills"; observed in `rules/`, `src/core/compilers.ts`, `modes/*.json`, ADR-020):** there is no training in the model sense. **Skills depend on the mode** (none, a list or all; enforced by flags for Claude, not verified for Codex). **Rules do not depend on the mode**: they are one `AGENTS.md` per project type (`rules/base.md` + one of four type files), written once. A mode adds rules only through a short `promptPrefix` (Interview, Review). That gap is part of the orchestrator-map design ("Teaching").
