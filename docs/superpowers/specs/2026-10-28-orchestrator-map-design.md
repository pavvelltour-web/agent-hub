# Orchestrator map, sub-run control and step journal: design

Status: **proposed, not approved** (only the user approves). Nothing in this document is built.
Marks: **[user]** = the user's words · **[call]** = my decision, change it if you disagree · **[open]** = needs the user's answer.

## Intent and why

**[user]** (2026-10-28, paraphrased from Russian): check that the pipelines are correct; check agent teaching and that the chosen tools are strictly English; a mode picker or the normal mode; the ability to interact with each sub-agent; animations; schemes in the admin panel that show the project as an orchestrator with branches to sub-agents, each showing the sub-agent's model, context window, task, goal, logs and a description of what it does and why; every step recorded in specs and the docs kept up; full development cycles.

The common thread: a person running several agents cannot see **who is doing what, why, with what context, and what it cost**, and nothing keeps a durable record of each step. The map makes the work visible; the journal makes it durable.

## Goals

1. One screen, **Map**, for a project or task: the orchestrator at the top, a node per sub-run below it, edges labelled with *why* the child exists, live state animated.
2. Each node opens a detail drawer: agent and model, effort, status, goal (the task text), context used vs limit, tokens and cost, branch, the log (the existing event stream), and a plain "what and why" line.
3. **Interaction with each node** where it is technically possible (see "What 'interact' can mean").
4. A **step journal**: every step of a run (start, spawn, verify, review, handoff, finish) is appended to a record; the person can write it into the project's `specs/` and the docs through the hub's usual plan-and-approve flow.
5. The full cycle is visible as a lane on the map: Interview → Plan → Task (worktree) → Review gate → Docs → Retro, using the existing modes and stages.
6. Agent-facing texts are strictly English, enforced by a test.

## Non-goals and anti-goals

- Not a new agent runtime and not a replacement for the CLIs' own sub-agents.
- **Anti-goal:** a pretty picture that claims more than is measured. Anything not measured says "not measured" on the node (for example a native sub-agent's context window).
- **Anti-goal:** the hub silently writing into the user's project. Journal and docs go through a plan the user approves, with backup and undo (existing rule).
- No real model runs in tests: the fake agent only.
- No auto-translation of the whole panel into English.

## Constraints that come from the code (observed)

- A run is one row in `run` with `handoff_of`, `resume_of`, `branch`, `cls`, `work_mode`; cascade rungs and review-gate reviewers are runs too; per-call context sizes are stored as `turn` rows (ADR-024). So the tree of hub-owned runs can be built from data that already exists.
- The hub has **no entity for CLI-native sub-agents** (Claude's Task tool, Codex sub-agent threads). It ignores their token usage and the live chat only nests their tool calls (`parent_tool_use_id`, `web/js/transcript.js`). Max 4 live runs (`MAX_CONCURRENT`).
- Tokens of a native sub-agent's own context are not reported by the current parser. **[inferred]** the stream carries the sub-agent's lines with `parent_tool_use_id`; whether the sub-agent's model and usage are in them has not been seen on a real signed-in CLI.

## What "interact" can mean

**[user]** (2026-10-28, second message): sub-agents are shown separately, and so are background processes and the like. So the map has distinct node kinds, each drawn differently:

| Node kind | Source | Observe | Message it | Stop it |
|---|---|---|---|---|
| **Hub-owned run** (cascade rung, review reviewer, handoff continuation, chat or task run) | `run` table | yes, live | **yes**: a follow-up message resumes that run's own session (same agent), existing `resume` path | yes (existing stop) |
| **Native sub-agent** (a Task call inside a run) | events of the parent run | yes, read-only | **no, not directly**: the CLI gives no channel to a running sub-agent. The drawer offers "ask the orchestrator about this", which sends a message into the parent run that names the sub-agent | only by stopping the parent |
| **Background process of an agent** (a shell the agent started with `run_in_background`, and its output reads) | tool events of the parent run **[inferred]**: the `tool` event carries the input; the real shape was never seen on a signed-in CLI | status and output so far | no | read-only; "ask the orchestrator to stop it" |
| **Hub background job** (graph update, scheduler job of the leftover-limit feature) | hub's own state (`src/core/graph.ts`, the scheduler's state file) | yes | no | yes, through the existing controls (single-flight graph update, switch-off and cancel of a scheduled item) |
| **MCP server started for a run** | the run's lean tool plan (ADR-020) | which servers, from the plan | no | stops with the run |

**[call]** I will not pretend a direct channel exists for native sub-agents. This is the one point most likely to differ from what the user pictured.

## The Map

- **[call]** Layout: top-down tree drawn as SVG in the existing panel (plain ES modules, `h()` DOM builder, no library, ADR-010/012). Orchestrator = the root run of a task chain; children placed by `handoff_of`, `resume_of`, cascade rung order and review round; native sub-agents attached to the run that called them.
- Edge label = the reason: `escalation after failed verify`, `review hunter`, `review verifier`, `handoff: limit`, `handoff: context 250K`, `native sub-agent`, `background shell`, `hub job`.
- Kinds look different (shape and glyph, not only colour): orchestrator and hub runs are rounded cards; native sub-agents are smaller cards on a dashed edge; background processes and hub jobs are pill-shaped with a spinner glyph while running; MCP servers sit in a row under their run.
- Node shows: agent glyph, model, effort, status chip, a context bar (used / limit, from `turn` rows), cost, one-line goal.
- **Animations [call]:** a moving dash on the edge of a live run; a soft pulse on a running node; a short settle when a node finishes; green/red state change. All CSS, tokens from `design/tokens.css`, and `prefers-reduced-motion` turns them off. Verified in all four themes and at 375 px (AGENTS.md rule).
- Live updates reuse the existing SSE stream; the map polls the tree endpoint only when no run is live.
- New read-only endpoint `GET /api/map?projectId=&root=` returns `{ nodes, edges }`; nothing new is stored for the tree.

## Step journal and docs

- **[call]** An append-only journal per task in the hub data folder (`journal/<project>/<task>.jsonl`): time, step kind, run id, agent, model, goal line, outcome, links to the log. Redacted with the existing redactor; bounded size.
- A rendered `steps.md` preview in the panel. **"Write into the project"** produces a plan for `specs/<task>/steps.md` (and, when a task finishes, proposed edits to STATUS and the ADR index) that the user approves as for any write into a project. The hub never edits docs by itself.
- **[call]** "Full development cycle" is the existing pieces on one lane, not a new engine: Interview mode → plan → Task mode in a worktree → review gate → docs plan → retro stage.

## Teaching: rules by mode, skills by mode

**[user]** (2026-10-28): "teaching agents" means the rules that depend on the mode, and the skills.

Today (observed in `rules/`, `src/core/compilers.ts`, `modes/*.json`, ADR-020):
- Rules are **one `AGENTS.md` per project type** (`rules/base.md` plus `web-saas`, `mobile-app`, `automation` or `design-study`), written once and never overwritten. They do **not** depend on the mode.
- Skills **do** depend on the mode (`skills` in each mode file: none, a list, or `["*"]`; Interview adds `grill-me` if installed). For Claude this is enforced with flags; for Codex it is **not** (no verified setting).
- A mode adds rules only through a short `promptPrefix` (Interview and Review have one).

**[call]** Proposal: each mode gets a rules file `rules/modes/<mode>.md` (English), sent as a prefix of that run's prompt, **not** written into the project's `AGENTS.md` (that file's edits clear the prompt cache for every later session). The prefix is built in one place and recorded on the node, so the drawer shows exactly what this agent was taught: the rules files and the skills loaded for the run, with their token cost where the hub already estimates it. A test pins, per mode, which rules and skills a run receives. For Codex the drawer says "skills not restricted by the hub" until a setting is verified.

## English-only agent-facing text

- **[call]** Scope: everything an agent reads: `registry/` (catalog and starter data except the human-facing `why`), `modes/*.promptPrefix`, `rules/`, `templates/`, `stages/` instructions, journal entries sent to an agent. A test fails when Cyrillic appears in those paths. The panel UI and the human-facing `why` and mode titles stay Russian.
- Today 12 of 20 template files and `stages/stages.json` are Russian (see PIPELINES-REVIEW F2); they would be translated in this work.

## Stages

- **Stage 1 (this design):** the map, the drawer, messaging of hub-owned runs, the journal and the English test, with a fake-agent scenario that emits native sub-agent events.
- **Stage 2 (a separate design and ADR):** an *orchestrator mode* in which a lead agent's plan is split and the hub spawns workers in their own worktrees. It touches the process, concurrency and security boundaries and needs an Opus review of the diff.

## Verification plan

Tests first (red, then green): tree builder from `run` rows including cascade, review and handoff chains; native sub-agent extraction from fake events; the message path resumes the right run and refuses a node it cannot message; journal append, redaction, size bound, and the plan for writing into the project; the English test. UI checked in the built-in browser against the demo server in four themes and at 375 px. Unverifiable here: anything with a real signed-in CLI.

## Open questions for the user

1. **[open] Scope of this round.** Stage 1 only (everything above), or also Stage 2 (the hub spawns workers)? Recommended: Stage 1 now.
2. **[open] Where may the journal be written?** Hub data folder plus an approved write into the project's `specs/` (recommended), or hub data only.
3. **[open] "Strictly English".** Agent-facing text only (recommended), or the whole panel UI too.
4. ~~"Teaching agents"~~ **answered by the user:** rules by mode, and skills (see "Teaching").
5. **[open] Mode rules: new content.** The rules text for each of the five modes does not exist yet. **[call]** I draft short English files from the mode hints and prompt prefixes already in `modes/*.json`; you review the wording before they ship.
