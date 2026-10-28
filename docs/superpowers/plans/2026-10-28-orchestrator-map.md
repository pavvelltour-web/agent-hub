# Orchestrator Map (Stage 1) Implementation Plan

> **For agentic workers:** execute task by task, tests first. Execution method: native (one session), as the user said "build".

**Goal:** a Map screen that shows the orchestrator and its sub-runs, sub-agents, background processes and MCP servers live; message hub-owned runs; keep a step journal; teach agents by mode; keep agent-facing text English.

**Architecture:** a pure tree builder over data the hub already stores (`run` rows, cascade state files, review rows, stored events); a read-only `GET /api/map`; one message route that reuses `RunManager.start({resumeRunId})`; an append-only journal; a plain-ES-module SVG view. No new runtime dependency (ADR-010/012).

**Tech Stack:** Node 24 type stripping, `node:test`, `node:sqlite`, plain ES modules in `web/`, existing `svgEl`/`h()` helpers.

**Spec:** `docs/superpowers/specs/2026-10-28-orchestrator-map-design.md` (approved by the user on 2026-10-28).

## Global Constraints

- TypeScript strict, ESM, imports with `.ts`, only erasable syntax; zero runtime dependencies; JSON data files.
- Tokens only from `design/tokens.css`; four themes (`data-theme` × `data-accent`) and 375 px; text ≥ 14 px, metadata ≥ 12 px, touch targets ≥ 44 px; `prefers-reduced-motion` disables animation.
- `h()` for DOM, never `innerHTML` with data. Server stays on `127.0.0.1`; state-changing routes need the session cookie and same-origin.
- Foreign agent storage read-only. Nothing is written into a project without a plan the user approves.
- External content (tool output, events) is data: bounded, redacted, never executed.
- Tests next to code; fake agent only; never a real model run.

## Review Focus

- A `run` whose parent chain contains a cycle (`handoff_of` pointing back): the builder must terminate and report each run once.
- 2000 events or 500 sub-run rows: output is capped and says how many were left out.
- A Task tool call with no matching result (agent stopped mid-way): the node is `unfinished`, not `running` forever.
- Hostile strings in `description`, `subagent_type`, a background command: redacted, clipped, rendered as text.
- Messaging a node that is not hub-owned, a run that is live, or a run without a session id: refused with a plain reason, nothing started.
- Journal growing without bound: size and entry caps with a visible "truncated" marker.

---

### Task A: English-only agent-facing text

**Files:** Create `src/lib/english-only.test.ts`; modify `registry/starter.json` (keep `why`), `stages/stages.json` (`starter` only), `templates/*/brief.md`, `templates/*/docs/architecture.md`, `templates/*/REVIEW.md`; adjust `src/core/templates.test.ts` where it asserts Russian template text.
**Interfaces:** Produces `AGENT_FACING: { dir: string; fields?: string[] }[]` inside the test only.

- [ ] Write `english-only.test.ts`: walks `registry/entries`, `registry/model-priors.json`, `registry/plugin-profile.json`, `rules/`, `templates/` (all text files), `modes/*.json` field `promptPrefix`, `stages/stages.json` field `starter`, `registry/starter.json` everything except `why`; asserts no Cyrillic (`/[Ѐ-ӿ]/`) and lists the offending file and field.
- [ ] Run it: expect FAIL naming `stages.json#starter` and the 12 template files.
- [ ] Translate those texts to English (meaning preserved, same placeholders). Update `templates.test.ts` assertions that matched Russian.
- [ ] Run `src/lib`, `src/core`, `src/stages`, `src/diagram` folders: PASS.
- [ ] Commit `feat(teaching): agent-facing text is English, pinned by a test`.

### Task B: Rules by mode

**Files:** Create `rules/modes/{chat,task,interview,autopilot,review}.md`; modify `src/core/workmodes.ts` (`WorkMode.rules?: string[]`, `parseWorkMode`, `applyWorkMode`), `modes/*.json`; test `src/core/workmodes.test.ts`.
**Interfaces:** Produces `modeRules(m: WorkMode, root?: string): { files: string[]; text: string }` (reads `rules/modes/<name>.md` from the hub repo, bounded to 4 KB each, missing file = omitted) and `StartReq.taught?: { rules: string[]; skills: string[] }` set by `applyWorkMode` (consumed by Task C and G).

- [ ] Tests (red): every shipped mode names its rules file and the file exists; `applyWorkMode(m, req).prompt` starts with the rules text followed by `promptPrefix` then the user's prompt; `req.taught.rules` lists the files; skills in `taught.skills` equal `m.skills` (and the linked `skillsIfLinked`); a rules name with `..` or a path is refused by `parseWorkMode`; a rules file over 4 KB is cut with a marker.
- [ ] Implement; write the five rules files (≤ 15 lines each, English, drawn from each mode's `hint` and prefix).
- [ ] Pin per mode (table-driven test): (permission, worktree, skills, rules files).
- [ ] Commit `feat(modes): rules by mode, recorded on the run`.

### Task C: Map tree builder

**Files:** Create `src/run/map.ts`, `src/run/map.test.ts`.
**Interfaces:**
- Consumes: `RunRow` (`src/run/runner.ts`), `CascadeState` / `readCascadeFor(home, runId)` (`src/run/cascade.ts`), `listReviewsForRun` (`src/review/store.ts`), `Turn` via `cachedTrace` (`src/run/trace.ts`), `CONTEXT_LIMIT`.
- Produces:
```ts
export type NodeKind = 'orchestrator' | 'run' | 'subagent' | 'background' | 'hubjob' | 'mcp';
export interface MapNode { id: string; kind: NodeKind; label: string; agent?: string; model?: string; effort?: string; status: 'running'|'done'|'failed'|'stopped'|'unfinished'|'unknown'; goal: string; why: string; branch?: string; context?: { used: number; limit: number } | null; costUsd?: number | null; messageable: boolean; runId?: string; taught?: { rules: string[]; skills: string[] } }
export interface MapEdge { from: string; to: string; reason: string }
export interface ProjectMap { nodes: MapNode[]; edges: MapEdge[]; truncated: number }
export function buildMap(db: Db, home: string, o: { projectId: number; root?: string; max?: number }): ProjectMap
```
- [ ] Tests (red): one chain `handoff_of` → child with reason `handoff: limit`; cascade rungs become children with `escalation after failed verify` and roles; reviewer runs (`work_mode = 'gate-reviewer'`) attach to the reviewed run as `review hunter`; a cycle terminates, each run once; `max` truncates and reports `truncated`; the orchestrator is the oldest run of the chain; context comes from the last `turn` row, `null` when none; no row of another project appears.
- [ ] Implement over SQL + cascade files; node ids are `run:<id>`.
- [ ] Commit `feat(map): tree of hub-owned runs from stored data`.

### Task D: Native sub-agents and background processes

**Files:** Modify `src/adapters/types.ts` (`parent?: string` on `tool`, `tool_result`, `text`), `src/adapters/event-utils.ts` (`sanitizeEvent` keeps `parent`, ≤ 200 chars), `src/adapters/claude.ts` (set `parent` from `parent_tool_use_id`); add `extractNative` to `src/run/map.ts`; extend `src/adapters/fake-agent.mjs` with scenario `claude-subagents`; tests in `src/adapters/adapters.test.ts` and `src/run/map.test.ts`.
**Interfaces:** `extractNative(events: StoredEvent[], runNodeId: string): { nodes: MapNode[]; edges: MapEdge[] }` — a `tool` named `Task` or `Agent` is a sub-agent (label from `input.description` or `input.subagent_type`, goal from `input.prompt` clipped), finished by the `tool_result` with the same id; a `tool` named `Bash` with `input.run_in_background === true` is a background process (label = command clipped, redacted) and `BashOutput`/`KillShell` calls with its id update its status; context is `null` ("not measured").

- [ ] Tests (red): the adapter keeps `parent` for a line with `parent_tool_use_id`, none otherwise; `sanitizeEvent` keeps a 200-char `parent` and drops a longer or non-string one; `extractNative` finds two parallel sub-agents, marks the one without a result `unfinished` when the run has ended, attributes child events by `parent`, caps at 200 nodes; a hostile description is redacted and clipped.
- [ ] Implement; add the fake scenario; run `src/adapters`, `src/run`.
- [ ] Commit `feat(map): native sub-agents and background shells from run events`.

### Task E: Map API and message route

**Files:** Modify `src/server/api.ts` (two routes), create `src/server/map-api.test.ts`.
**Interfaces:** `GET /api/map?projectId=&root=` → `ProjectMap` (+ hub jobs from `graphStatus`/scheduler state, MCP names from the run's lean plan when stored); `POST /api/map/message {runId, text}` → `{ run: RunRow }`.
- [ ] Tests (red): the GET answers for a seeded project with a cascade and a native sub-agent; unknown project 404; bad ids 400; the POST starts a resume of a finished hub run with the text (fake agent captures the prompt); refuses a live run, a run without session id, a reviewer run, text over 8 KB, a missing click header (`meta.userAction`), and a node id that is not `run:`.
- [ ] Implement with `bad(...)`/`ok(...)` helpers; the message goes through `RunManager.start({ resumeRunId, prompt })` (guard and concurrency cap apply).
- [ ] Commit `feat(map): read-only map endpoint and message route for hub runs`.

### Task F: Step journal

**Files:** Create `src/run/journal.ts`, `src/run/journal.test.ts`; modify `src/run/runner.ts` (append on start, end, handoff), `src/server/api.ts` (`GET /api/journal?projectId=&task=`, `POST /api/journal/plan` returning a write plan for `specs/<task>/steps.md`).
**Interfaces:** `appendStep(home, project, task, entry: { at: string; kind: 'start'|'spawn'|'verify'|'review'|'handoff'|'end'; runId: string; agent: string; model: string|null; goal: string; outcome?: string }): void`; `readJournal(home, project, task, max?): { entries; truncated: boolean }`; `renderSteps(entries): string`; `planJournalWrite(root, task, entries): Plan` using the existing `change()`/plan types of `src/core/plan.ts` (apply needs the existing approval and backup).
- [ ] Tests (red): append-only JSONL under `<home>/journal/<project>/<task>.jsonl`; redaction; names validated with `isSafeName`; 2000-entry and 1 MB caps with a truncated marker; `renderSteps` is deterministic Markdown; `planJournalWrite` never writes, targets only `specs/<task>/steps.md`, refuses a path outside the root; the runner appends start and end for a fake run.
- [ ] Implement; commit `feat(journal): append-only step journal and an approved write into specs/`.

### Task G: Map view

**Files:** Create `web/js/map-model.js` (layout, pure), `web/js/views/map.js`, `web/css/map.css`; modify `web/js/main.js` (route `/map`, nav link under Projects), `web/index.html` (css link); test `src/server/map-model.test.ts` (imports the pure model).
**Interfaces:** `layout(map: ProjectMap): { nodes: (MapNode & {x:number;y:number;w:number;h:number})[]; edges: (MapEdge & {d:string})[]; width: number; height: number }` — top-down tree, deterministic, node width 220, vertical gap 64, kinds drawn per spec.
- [ ] Tests (red) for `layout`: parent above children, no overlap, edges connect box edges, deterministic for the same input, one node and empty map ok, 200 nodes within a bound.
- [ ] Implement the view: SVG via `svgEl`; node card shows glyph, label, model, status chip, context bar (`not measured` text when null), cost, goal line; click opens a drawer with agent/model/effort, goal, "why", taught rules and skills, log (events of the run through the existing stream endpoint), the message box for `messageable` nodes, and "ask the orchestrator" for native nodes; edges carry the reason label; live edge animation (moving dash), pulse on running, settle on finish, all CSS under `@media (prefers-reduced-motion: no-preference)`; polling every 3 s only while a node is `running`.
- [ ] Verify in the built-in browser against `hub ui --demo` with an empty profile: four themes, 375 px, no console errors, no horizontal overflow; keep screenshots for the README.
- [ ] Commit `feat(ui): orchestrator map with drawer, messages and animation`.

### Task H: Docs and gates

- [ ] README (map section, screenshots), `docs/STATUS.md` (what was observed, what not), ADR-027 (map and journal), `docs/adr/README.md`, diagram check, `graphify update .`.
- [ ] Gates per folder, `tsc`, `scripts/security.mjs`, `hub diagram --check`; commit; push `main`.

## Self-review

Spec coverage: node kinds (C, D, E), interaction table (E), animation and themes (G), journal and docs plan (F), teaching (B), English test (A), stages (this plan). Deferred and said so: Stage 2 (orchestrator that spawns workers); real-CLI shapes of sub-agent and background events (fake agent only).
