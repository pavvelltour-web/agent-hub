# Agent Hub — status of v0.1.0 against PLAN.md

> 2026-10-22. Local only: nothing is published and no GitHub repository exists. Legend: ✔ done and tested · ◐ partial · ✘ not done.
> Evidence: 95 automated tests, strict typecheck, 14 security checks, real-machine runs described below.

## What was verified on the real machine

| Check | Result |
|---|---|
| Import of real Claude + Codex history | 441 Codex threads (8.5 GB of rollouts) + Claude sessions: **18 s** first run, **0.0 s** re-sync, 37 MB index, search 1 ms |
| Real `codex exec` through `hub run` | Account was at its weekly limit: hub recorded `limit` with reset time (27 Oct 12:03), wrote a handoff card, committed nothing in the working tree |
| Real `claude -p` through `hub run` | CLI is not logged in on this PC: hub reports it as an actionable "log in" message, not a crash |
| Real Codex `rate_limits` | Latest snapshot 94 % of weekly window, plan `prolite` — shown on Today / Models |
| Panel in Chrome | 4 themes × desktop and 390 px: no horizontal overflow, fonts load, no console errors; chat streaming, limit → handoff → continue verified with scripted fake agents (`hub ui --demo`) |
| Windows specifics | junction links, `\\?\` paths, process-tree kill, `claude.cmd` shim → `claude.exe`, stdin prompt of 50 k chars |

## Requirements

| ID | State | Notes |
|---|---|---|
| FR-L1 registry (command + description, no vendored files) | ✔ | JSON entries; 6 shipped + local skill scan with token cost |
| FR-L2 `init` dry run | ✔ | writes nothing; tested |
| FR-L3 skills for both agents | ✔ | junction, copy fallback recorded |
| FR-L4 rules: AGENTS.md + CLAUDE.md pointer | ✔ | never overwrites |
| FR-L5 MCP → both agents | ✔ | `.mcp.json` + Codex marker blocks; `hub mcp test` does a real MCP handshake for stdio servers (tested with a fake server), starts commands only with `--yes`; remote servers and Windows `.cmd` shims (npx) are not probed: verify in the agent (`/mcp`) |
| FR-L6 hooks IR | ✔ | (runner hooks run only after local approval, `hub hooks --approve`) | `hub hooks` classifies; `--adopt` writes simple commands into `hub.json` after an approved plan; the runner executes them around any agent session (argv arrays, no shell). Tool-level events (PreToolUse…) and shell-syntax commands are reported, not adopted. Codex-native hook files are not written |
| FR-L7 `hub.lock` reproducibility | ✔ | `hub install` (CLI, API, panel button) re-creates links and MCP from the lock; a source whose hash changed is refused |
| FR-L8 backup / undo | ✔ | byte-identical restore tested |
| FR-L9 scout | ✔ | local library + aitmpl.com catalog + GitHub search (`gh`); observed live. Proposals only (never installed), license shown or "unknown"; scored by brief and token cost |
| FR-L10 project profiles | ✔/◐ | per-agent visibility of every skill; project profile: Claude `skillOverrides` + `enabledPlugins` in `.claude/settings.local.json`, Codex marker block in `.codex/config.toml`, always via approved plan + backup. Claude keys are per official docs, **not run live**; Codex project-level override **not verified**. New tools install into the hub library (0 tokens until linked). See `docs/REPORT-v0.1.md` |
| FR-H1–H5 history | ✔ | Claude top-level sessions only (sub-agent folders not imported) |
| FR-R1 adapter contract | ✔ | Claude + Codex; success-path of Codex `--json` not confirmed live (account limited) |
| FR-R2 worktree | ✔ | sparse-checkout: path-validated, field in the task form |
| FR-R3 events / SSE | ✔ | ordered, no gaps, replay + live |
| FR-R4 limits | ◐ | Codex from logs ✔; Claude manual entry (CLI limit reading unverified) |
| FR-R5 handoff | ◐ | card with git facts ✔, same-folder continue ✔; story part written by Haiku when the Claude CLI is logged in, strict JSON shape, falls back to the deterministic summary; tested with a fake agent, **not run live** (CLI not logged in) |
| FR-R6 `hub open <agent>` | ✔ | starts the native CLI in the project folder with push blocked; not exercised interactively in this session |
| FR-R7 push guard | ✔ | proven: push fails under guard, works without |
| FR-E1–E4 prices, ranges, calibration, advice | ✔ | Claude prices verified 2026-10-22; GPT price unknown stays unknown; calibration needs ≥5 intervals |
| FR-E5 outcome tracking | ✔ | runs store class + the estimate shown; Models page compares actual weighted Mtok with the range, success rate per class/model |
| FR-S1 gates | ✔ | |
| FR-S2 project types | ◐ | 4 presets; design pipeline appears only when installed locally |
| FR-S3 design stage uses the author's pipeline | ◐ | in mandatory lists; add the pipeline folder in Settings → "Свои папки со скиллами" (or `hub config add-skill-root`); plugin layout `<root>/plugin/skills/*` is scanned |
| FR-S4 panel | ✔ | projects, chat, tasks, history, library (+ plugin profile, outside search), models (+ estimate vs actual), logs, settings (+ skill roots); Ctrl+K history search. UI is Russian only (English UI not done) |
| FR-S5 diagrams + `--check` | ✔ | generated from code; drift test |

## Deviations from the plan (recorded as ADRs)

ADR-010 single package, zero runtime dependencies · ADR-011 JSON instead of YAML · ADR-012 panel without React/build step · ADR-013 TypeScript via Node type stripping, `tsc` build for publishing · ADR-014 hub commits only on its own branches · ADR-015 prompt via stdin. See `docs/adr/`.

## Not verified / known limits

- Codex success path (`item.completed` types, `turn.completed` usage) is written from Codex's documented shape; the only live runs ended at the usage limit.
- Claude `rate_limit_event` shape is handled defensively, never seen.
- Docker daemon was off: gitleaks, semgrep and trivy have **not** been run (`hub security --docker`). Built-in checks passed.
- Not tested: macOS, Linux, Safari, a physical iPhone, screen readers. Contrast was measured for tokens and sampled in renders, not audited.
- The token→limit conversion for Codex is a wide prior (1–8 Mtok per 1 %) until enough measured intervals exist; Claude share of limit is unknown.
- Terms of use for driving subscription CLIs from a third-party orchestrator were not checked.

## Needs your decision

1. Aikido / CodeRabbit (they would receive code) — still off.
2. Log in the Claude CLI (`claude` → `/login`) so real chats and the model-written handoff summary can be tested.
3. Name and license for publishing; when to create the GitHub repository (agreed: together, after you review v0.1).
