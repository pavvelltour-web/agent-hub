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

## v0.2 Phase 3, tasks 3.5-3.7 (branch v0.2/p-pr-review)

Statuses: **observed** = ran or saw it in this session; **inferred** = reasoned, not run.

- **3.5 strategies** (observed): `compareStrategies` gives cost and weekly-limit share per solved task for always-max / manual / cheap-first / router; the Models page has "Сколько стоит решённая задача". `label` is `measured` only when every number comes from runs of that strategy; cheap-first is built from separate runs and is `estimated`. Checked in the rendered panel with a seeded temp home (dark/green desktop and 375 px, light/orange 375 px); the other two theme pairs are inferred (same components).
- **3.6 classify** (observed): keyword rules in Russian and English, confidence below 0.6 asks the user. Today screen pre-fills an editable type. Rule weights are the author's choice, not measured against real prompts: the accuracy on the user's own prompts is **not measured**.
- **3.7 prices** (observed): prices moved to `registry/prices.json` with an override in `<hub home>/prices.json` and an editor in Settings. GPT 6.1 Sol is priced $2 / $10, cached $0.10 from the v0.2 plan's Research basis (Artificial Analysis; the plan gives no URL and no date, so the row says "recorded 2026-10-26" and has no link). That figure has **not** been checked against its source.
- **Price discrepancy resolved by reading the cited page** (observed 2026-10-27, WebFetch of platform.claude.com/docs/en/about-claude/pricing): Sonnet 5.5 cache hits are **$0.10** (footnote: 0.05x of input), Opus 5.5 $0.20, Fable 5.1 $0.25, Haiku 5.5 $0.01 / $0.05; Claude Sonnet 5 is the one at $0.20. The code values were right. The claude-api skill reference that lists Sonnet 5.5 cache reads at $0.20 is wrong for 5.5 (it repeats the Sonnet 5 figure); do not "fix" the code to match it. The Claude rows are dated 2026-10-27 (the day they were read), so `pricesVerifiedAt` is now 2026-10-27.
- **Test hygiene found** (observed): `src/history/history.test.ts` never removes its `hub-hist-*` temp folder (~20 MB each, including a 50 MB+ file); about 90 of them filled the system drive to 7 MB free and broke 27 unrelated tests with ENOSPC. They were deleted by hand. Fixed afterwards: the test now removes its folders (commit `6622d30`).
- **Flaky under suite load** (observed): "work mode permissions over the API" in `src/server/server.test.ts` raced the fake agent's session id (a fixed 400 ms wait; `400 !== 200` on the resume, seen 3 times, once in isolation). The test now polls for the session id (`a408b59`; 8 of 8 isolated runs and 10 of 10 later green). It still failed once in a full run after that fix, cause not yet found (see the Phase 3 summary below).

## v0.2 Phase 3 summary (tasks 3.1-3.7)

Statuses as above; **proposed** = not built.

- **3.1 effort routed, 3.2 sourced priors, 3.3 cascade, 3.4 quality from verification** (observed: tests, tsc, security, diagrams): commits `08b187d`, `f3ab516`, `fd0cbfb`, `6faefb0`. A verify command, not the agent's own claim, now decides `done`; `done` without verify scores 0.5 (was 0.7), a verify pass scores 0.9 and a fail 0.1; a rejected review (`reconsider` or a red check) caps a verify pass at 0.1.
- **Cascade trust boundary — two Opus rounds** (observed; each defect was reproduced with a script before the fix): verify runs in a clean copy built from raw git blobs of the checkpoint commit (no filters, no symlinks that leave the tree, 200 MB / 50 000 files cap); a failed or filtered `git add` and a branch swap are agent-caused blocks; test edits are detected from `--name-status/--numstat -z` (quoted paths), test-runner configs, nested `package.json` runner keys, fixtures, `.only`/skip markers and added early exits. Commits `9f6cdcb`, `c5e3a3f`. The review of the second repair round is Opus-by-reading plus the author's red→green tests; **a third independent review was not done**.
- **Known limits (documented in ADR-017):** test-edit detection is a heuristic, not a proof; the checkpoint's config guard covers filters, attributes and fsmonitor, not every git config key that can run a program; symlink entries in the copy are written as plain text (not refused); `node_modules` comes from the project root, so a branch that adds a dependency not installed there stays red; verify code still runs with the user's rights.
- **Not measured:** no real `claude` or `codex` run has driven the cascade or the reviewers (Claude CLI not signed in here; codex rejects `gpt-6.1-sol` for ChatGPT accounts), so cascade success rate, reviewer recall and noise, and the classifier's accuracy are **unmeasured**. The plan's `hub bench` comparison of router picks vs `always-max` (paid, needs signed-in CLIs) was **not run**; there are no bench numbers here and none should be inferred. Run `hub bench --picks sonnet:high,gpt-6.1-sol:medium` once signed in.
- **Open flake:** after the polling fix, "work mode permissions over the API" still failed once in a full-suite run (3 of ~6 full runs overall, isolated runs all green). Cause not found.
- **Decisions left to the user:** `AGENTS.md` still says "Sonnet 5.5 (medium)" for implementation while the router default is now `sonnet:high`; `graphify` has not been refreshed (`/graphify . --update`).

### Review fixes for 3.5-3.7 (Opus review, observed)

- **classify**: a critical-decision word (ADR, irreversible, security boundary, and their Russian forms) now wins over weaker evidence for any other class, at the evidence of its own words (>= 0.7), and `why` says the strictest type was set and can be lowered. Before, "Change the security boundary: fix failing crash in auth" came out as debug 0.64 and Today set it silently.
- **prices**: a price of 0 or below is refused in every column (the bundled registry has no zero price, cache hits included); every dropped row carries a reason; an unreadable, over-64 KB or over-200-row override file is reported (`overrideProblem`) and a save refuses to start from it, so it can no longer be wiped by a later save. Temp file name is unique per write. Saves in one process cannot interleave (the read-modify-write is synchronous); that, not a lock, is the in-process guarantee. The file is re-checked once a second, so an edit by another program is picked up.
- **override visibility**: every router option and `choice`/`alt` carries `overridden` when its price (own row, the Fable scale, or the Sonnet stand-in) came from the user's file; Today and Models show the chip "цена изменена вручную".
- **strategies**: rows are compared only on the types every strategy has runs for; each row carries `types` and `typesOf`; a strategy with a wider own mix is `estimated`; Models says "Сравнено по N типам из M".
- **Fable cache ratio**: the Anthropic page (read again 2026-10-27) says 0.025x for Fable 5.1 and Mythos 5.1 (footnote 1: $0.25 on $10) and 0.05x for Opus 5.5 and Sonnet 5.5. The registry value $0.25 was right; the row's source text now states 0.025x. The "0.05x for Fable" in the review note is not what the page says.


## v0.2 Phase 4, tasks 4.1-4.2 (branch v0.2/p-pr-review)

- **4.1 context rules** (observed): `rules/base.md` (what other projects get) carries the four token-saving rules verbatim (the graph rule is conditional on `graphify-out/` existing) and all 14 Autopilot lines merged with the old Hard rules; rendered text is 57-68 lines for every project type (cap 70), no repository-overview section, no filler phrases. The hub's own `AGENTS.md` does not copy base.md: it has the Autopilot lines that fit a repo whose rules are already spelled out (contract, placeholders, irreversible actions, repair verbatim, caps, cause first, three-step changes, phase rules at phase start, review axes, blind acceptance, one line per task, leaked secret is a stop condition, pointers not a retelling) and lost its repository map (the graph is the map). Whether agents follow the shorter rules was **not measured**.
- **4.2 tool sets** (observed: argument assembly, MCP file contents, cleanup, warn, with a fake agent; **not measured**: first-call size on a live run, the CLI is not signed in). `leanPlan`/`leanArgs`: Claude gets `--disable-slash-commands` when the mode lists no skills, `--strict-mcp-config --mcp-config <file>` when the mode names MCP servers (`mcp` in the mode file, optional), `--settings` in worktrees as before. Server definitions come only from the hub library, env as `${NAME}` references, all-or-nothing with a warning (ADR-020). Codex: nothing passed (no verified key).
- **Skills per mode** (observed in tests): skills are on or off per run, not filtered. A mode with `skills: []` starts with them off; any non-empty list keeps them on, `["*"]` is the explicit all. Shipped: chat and task `["*"]` (unchanged behaviour), autopilot `["autopilot"]`, interview and review `[]` (off). Task 5.3 may name skills for interview.
- **4.3 fresh context at the right size** (ADR-018). Observed with a fake agent, red then green: a task run whose per-call prompt crosses 250K gets one warn, is stopped by the hub (outcome `context`), leaves a checkpoint commit and a card with `reason: context`, and a fresh run continues in the same worktree and branch from the card; below the limit, with the limit raised or switched off, nothing happens; a chat in the user's own folder is only warned; a chain is capped at three sessions. Claude adapter reads per-call usage from `assistant` lines (hostile values ignored). **Not verified live**: that real `assistant` lines carry `message.usage` in that shape, that 250K is right for the user's models, and any token saving (**not measured**, CLI not signed in). Inferred: Codex is left out because its `turn.completed` input count may be summed over a turn.
- **4.4 graph as a project tool** (ADR-021). Observed with a fake graphify (tests, red then green): the init plan adds a `.graphifyignore` and a Russian note only when graphify is available and never replaces the user's file; status is missing / built / stale by modification time, ignoring `.graphifyignore`, `.git`, `node_modules`, generated and git-ignored files; `POST /api/graph/update` needs `approved: true`, runs `graphify update <root>` in the background (argument array, empty throw-away cwd, allowlisted environment without API keys, 10-minute kill, one at a time, redacted, written to the Journal). **Observed with the real graphify** (python module on this PC, no model call): the panel confirmed and built the graph of a throw-away project in about 2 s and the card moved built to stale after an edit. UI checked in the built-in browser at 375 px (dark/green and light/orange, no horizontal overflow, 46 px button, 15 px text) and by measured contrast in all four themes (6.2 or more); desktop checked by geometry only because the pane crops screenshots. **Not verified**: large repositories, other OS, any token saving (**not measured**).
- **Phase 4 not yet reviewed**: the plan's "observed before/after first-call size and tokens per solved task" needs a signed-in CLI and a fixed task set; none of those numbers exist yet.


- **Review fixes for 4.1-4.2** (observed with a fake agent; not run against a live CLI): MCP entries may not carry `$`, plain http, a shell launcher or unverified provenance; `mcp: []` and every refusal now start NO MCP server (fail closed, a warn says why) instead of falling back to the user's whole set; shipped catalog entries win over hub-home entries with the same id in the panel and in runs; a missing or malformed work mode warns; temp MCP files are removed if the start throws and swept after a day; on Windows the temp folder must be inside the user profile (0600 is ignored there). Details in ADR-020.
- **Review fixes for 4.3/4.4** (red then green in tests, except where noted): linear `.graphifyignore` matcher with caps (S1); git config guard on the status/plan `ls-files`, a core.fsmonitor marker does not run (S2); a cascade rung never auto-restarts, the cascade stops with a "context" reason (S3); Stop wins over a buffered context line and cancels a pending restart (S4); one original task text per chain (N1); card summary in a nonce DATA block (N2); cls/est carried (N3); subagent usage ignored (N4); context stops counted apart and left out of estimates (N5); links out of the project refused (N6); dependency folders dropped before the file cap (N7, red observed by temporarily restoring the old order); UI label, Journal row field and a link to the new run (N8, checked at 375 px by geometry: 44 px target, 14 px text, no overflow, contrast 7.4 or more in all four themes). Not closed: the "stopped by user" ordering test for S4a depends on both lines arriving in one chunk; the 60 s negative cache of `locateGraphify` has no test.
