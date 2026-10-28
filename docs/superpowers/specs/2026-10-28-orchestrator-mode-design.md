# Orchestrator mode (Stage 2): the hub splits a goal and runs workers, then merges only what passes the gates

Status: **proposed, waiting for the user's approval of this document.** No code is written. ADR: `docs/adr/028-orchestrator-mode.md` (draft).
Marks: **[user]** = the user's words · **[call]** = my decision, change it if you disagree · **[open]** = needs the user's answer · statuses of facts: **observed** (read in code) · **inferred** · **proposed**.

## Intent and why

**[user]** (2026-10-28): "Start stage 2" (the orchestrator hands tasks to workers). Answer to the one question: **the hub merges the workers' branches itself**, and checks are mandatory: unit tests, QA cases (through Playwright, or just autotests), security check, code cleanliness and size ("so that it is understandable / the agent can work with it"), and context convenience with graphify, permanently. The person must see **which skills and plugins take part in the project, and in a few words how they help and what they do**. "In general good, do it."

Stage 1 made the work visible (the map). Stage 2 makes the hub able to **do** the split: one goal in, several workers in their own worktrees, one verified integration branch out. The person still decides twice: the plan before anything starts, and the final merge into their own branch.

## Goals

1. `hub orchestrate "<goal>"` (and a panel button on the Map screen) runs a **planner** that proposes pieces of work; the person approves the plan; the hub runs one **worker** per piece; the hub verifies, merges and gates; the person gets one branch `hub/<task>/integration` to review and merge.
2. Every piece passes **gates** before it is merged; the integration branch passes them again as a whole (see "Gates").
3. The map shows the orchestrator → planner → workers → gates → integration as nodes; each worker keeps its model, context, goal, log, and the gates' results.
4. The panel shows **the team**: skills, plugins and MCP servers available to the project and to each node, one line each: what it is and what it does here (see "Team panel").
5. The graph (`graphify`) is part of the loop: workers are given graph slices for their piece, and the graph is refreshed on the integration branch after each merged piece.

## Non-goals and anti-goals

- **Anti-goal:** an agent that starts processes or merges. Agents only write code in their own worktree; **only the hub spawns, verifies and merges** (same boundary as Stage 1: hub code is the sole spawner).
- **Anti-goal:** the hub writing to the person's own branch, pushing, or resolving a merge conflict by guessing. A conflict stops the piece and is shown.
- **Anti-goal:** green gates that mean nothing. A gate that is not configured is shown as "not configured" and blocks the integration, unless the person waives it for this task in the plan (visible on the map and in the journal).
- No new runtime dependency (ADR-010). **Playwright is not added to the hub** (see "QA cases").
- No nested orchestration (a worker cannot start workers) and no more than 8 pieces per task.
- Not in this stage: remote machines, merging into the main branch, conflict resolution by a model.

## Constraints from the code (observed)

- A run is a row in `run` (`parent_run`, `spawn_reason` since Stage 1); `RunManager.start` enforces `MAX_CONCURRENT = 4` live runs for the whole hub (`src/run/runner.ts:40`) and the circuit breaker (ADR-026) before anything is created. The orchestrator itself is not a run (it is hub code), the **planner is one run**, each worker one run, so at most **3 workers at once** while the planner is not running, 4 otherwise.
- A worktree is `<repo>-worktrees/<task>-<agent>` on branch `hub/<task>/<agent>`, from the current HEAD (`src/run/git.ts:34`; Stage 2 passes an explicit base commit, see decision 5). Two workers with the same task and agent would collide: the piece id is added to the name (`hub/<task>/<agent>-<piece>`, piece ids are `isSafeName`).
- Agents cannot push (`pushGuardEnv`), hub secrets are removed from their environment (`agentEnv`), and the hub's git calls that touch agent-controlled branches use `agentConfigGuard` and no hooks (`checkpoint`).
- Cascade (ADR-017) already has: approved verify argv with digest, verification in a clean copy of the commit (`exportCommit`), a detector of weakened tests (`testEdits`). The review gate (ADR-019) already ends in the person's approval. Stage 2 **reuses** these and does not write a second copy.
- `listPlugins` (`src/core/profile.ts`) reads enabled plugins and the token cost of their skills (read-only). Skills by mode exist (ADR-020). The tool catalog has English id/title/description and person-facing `why`.

## The flow

```
goal ──► planner run (read-only, Opus) ──► plan.json ──► [person approves the plan, digest-pinned]
                                                              │
                          ┌───────────────────────────────────┘
                          ▼
        pieces with disjoint files run in parallel (≤3), overlapping ones in sequence
                          │   each piece: worktree → worker run (Sonnet, edit) → hub verify
                          │   red? → the worker gets the output once (1 repair) → still red = piece failed
                          ▼
        green pieces merged by the hub into hub/<task>/integration (one at a time, in plan order)
                          │   conflict → piece failed, orchestration pauses (needs-decision), shown to the person
                          ▼
        gates on the whole branch → review gate (ADR-019, Opus on the diff) → ready for the person
                                                                  │
                                           person reviews and merges into their own branch
```

State lives in a file `<home>/orchestrations/<id>.json` (files are the source of truth, like cascades); the DB only indexes runs. Statuses: `planning → plan-ready → running → integrating → gating → ready | blocked | stopped | failed`. Stop cancels live workers and leaves branches as they are.

### The plan (`plan.json`)

The planner's output is **data, never instructions**; the hub parses and validates it and the person approves the validated form.

- Per piece: `id` (safe name), `goal` (one paragraph), `files` (paths or folders the piece may touch), `cases` (QA cases, plain sentences; at least one), `needs` (ids of pieces it depends on), `agent`/`model` suggestion (the hub's router decides within allowed agents).
- Validation: ≤ 8 pieces; ids unique and safe; `files` pass the `checkSparse` rules (no `..`, no `.git`, no credential folders, no absolute paths); `needs` has no cycle; text lengths bounded; anything else is dropped and said so.
- **[call]** Overlap: pieces whose `files` overlap (one is a parent folder of the other, or the same file) are run in sequence, never in parallel. The hub also checks **after** the worker: a diff touching paths outside `files` is a `scope` gate failure (a planner's list is a promise, the diff is the fact).
- The person approves through the existing plan-and-approve flow (userAction click, digest of the shown plan). Editing the plan (remove a piece, change text) produces a new digest.

## Gates (what "checked" means)

All gates run **by the hub in a clean copy of the commit** (as the cascade's verify does), never by the agent, with approved argv (digest-pinned) from the project's `hub.json` `gates` block. A category without a command is "not configured" (blocks, unless waived in the approved plan).

| Gate | What | Source of the command |
|---|---|---|
| **tests** (required) | unit tests of the project | approved argv (default proposal: the `test` script of `package.json`) |
| **qa** | the plan's **cases**: every case must map to a test that exists and passes; for web projects an **end-to-end command** | see "QA cases" |
| **security** | the project's security command (the hub itself: `scripts/security.mjs`) plus the hub's **built-in diff scan**: secret patterns (the redactor's), new network/exec calls flagged for the reviewer, credential file names | approved argv + built-in |
| **quality** | built-in: **size** limits and test-weakening (`testEdits`); plus the project's typecheck/lint argv if approved | built-in + approved argv |
| **scope** | built-in: the diff stays inside the piece's `files` | built-in |
| **graph** | `graphify` is current on the integration branch (see "Graph") | built-in |

**Size [call, number is a guess; change it]:** a piece may change at most **400 lines in at most 12 files**; a changed or new source file should stay under **400 lines**; the planner is told these limits, and a piece over them fails `quality` with the numbers and goes back to the planner as "split this" (one re-plan, with the person's approval, never silent). The reason is the person's: small pieces stay understandable for the agent that reads them and for the reviewer.

### QA cases (Playwright or plain autotests)

- **[call]** The hub does **not** depend on Playwright and never installs it (ADR-010; a new dependency needs the user's OK and an ADR). Instead the `qa` gate runs the **project's own** end-to-end command if the project has one (for example a `test:e2e` script that uses Playwright), approved like any other argv. If the project has none, `qa` falls back to plain autotests and says so on the node ("no e2e configured").
- The planner writes **cases** as plain sentences; the worker must add a test for each case (named after the case id in a comment/test title); the hub checks the mapping by searching the case ids in the changed test files. A case without a test is a `qa` failure. This is a heuristic (a test that asserts nothing passes the mapping, not the review): the review gate's Opus pass reads the cases against the tests.
- For this repository (the hub itself) the panel is checked in the built-in browser by the person or the session; **no e2e command exists yet** and none is added in this stage.
- **[open 1]** Do you want me to *propose* adding Playwright to this repository as a **dev** dependency in a separate task (needs your OK + ADR), or keep the hub's own UI checked by browser sessions as now?

### Graph (graphify) as part of the loop

- **Context in:** before a worker starts, the hub runs `graphify query "<piece goal>" --budget 800` against the **root graph** (read-only) and puts the node list (file + section) at the start of the worker's prompt, so the worker opens only what the graph points to (AGENTS.md read order). If the graph is missing, the worker is told so.
- **Refresh out:** after each piece is merged into the integration branch, the hub runs the code-only `graphify update` in the **integration worktree** and commits the graph files on that branch with the merge. The `graph` gate fails when the committed graph does not match the branch tip. On the map this is a hub-job node.
- **[open 2]** AGENTS.md says "worktrees use the root graph; never build a copy inside a worktree". Committing the graph on the integration branch is what keeps the graph current without a separate step, but it builds graph output inside a worktree. Options: (a) **recommended**: allow it only for the integration worktree, once per piece, and say so in the ADR; (b) refresh in the root checkout after you merge (graph is stale during the run, workers query an older graph). I will not edit AGENTS.md without your word.

## Team panel: skills, plugins, MCP

**[user]** wants to see which skills and plugins take part in the project and, briefly, how they help and what they do.

- New block "Team" on the Map screen (also shown per node in the drawer). One row per item: **kind** (skill / plugin / MCP server), **name**, **what it does** (the first sentence of its own `description`, trimmed to ~140 characters, from the SKILL.md / catalog entry; shown with `textContent`, treated as data), **how it helps here** (the person-facing Russian `why` from the starter kit or the project's own notes when one exists; otherwise the row says "no note", the hub never invents one), **state** (enabled / available / disabled), **cost** (tokens per turn where the hub already estimates it).
- Per node: **given** (the mode's skill list and rules, known) and **used** (a `Skill`/tool call seen in the run's stored events, **inferred**: the real event shape was never seen on a signed-in CLI; shown as "seen in the log", not as a promise).
- Source: `listPlugins`, skill roots (`skillRoots`), the registry catalog, the run's lean tool plan (ADR-020). Read-only; no new files written.
- **[call]** For Codex the panel shows "skills not restricted by the hub" as in Stage 1.

## Map, journal, API

- **Map:** the orchestration is the root node (kind `orchestrator`); planner and workers are hub runs with `parent_run` = the planner's/orchestration's root run and `spawn_reason` `planner` / `worker: <piece>`; gates and the merge are hub-job nodes; edges say why. A worker can be messaged like any hub run (Stage 1 rule).
- **Journal:** every step (plan proposed, approved, worker start, verify red/green, repair, merge, conflict, gate results, review, ready) is appended to the Stage 1 journal and can be written into `specs/<task>/steps.md` through the existing approved plan.
- **API (proposed):** `POST /api/orch/plan` (goal → planner run), `GET /api/orch/:id`, `POST /api/orch/:id/approve` (plan digest, panel click), `POST /api/orch/:id/stop`, `GET /api/orch` (list). CLI: `hub orchestrate`, `hub orchestrate --status`. Every write route needs the cookie **and** the panel click (`meta.userAction`), as the other write routes.

## Safety boundaries this stage touches (needs an Opus review of the diff, AGENTS.md)

1. **Process spawning:** only the hub spawns; argv arrays only; the planner has `plan` permission (read-only); workers `edit`, never `full`.
2. **Paths:** piece `files`, worktree names, branch names validated (`isSafeName`, `checkSparse`); writes only in the project's worktree area.
3. **Agent-controlled git config:** every hub git call on a worker branch uses `agentConfigGuard` and no hooks; the merge is made by the hub in the integration worktree, never by an agent.
4. **Trust of model output:** plan, cases and descriptions are data; shown with `textContent`; the approved digest covers exactly what was shown.
5. **Cost and runaway:** the breaker applies to every run; additionally ≤ 8 pieces, 1 repair per piece, 1 re-plan, a wall-clock limit for the whole orchestration, and a stop button.
6. **No push, no write to the person's branch:** the final merge is the person's.

## Stages of building (each ends green and committed)

- **2a Core:** plan schema + validation, planner start, approval, scheduler for pieces (overlap rules, ≤3 workers), per-piece worktrees, hub verify and 1 repair, merge into the integration branch, state file, stop. Fake agent scenarios `planner-ok`, `worker-edit`, `worker-red`, `worker-conflict`.
- **2b Gates:** tests/security/quality/scope/qa/graph gates, size limits, built-in diff scan, `hub.json` `gates` block with approval, graph slices into prompts, graph refresh on integration.
- **2c Panel:** plan approval screen, orchestrator nodes on the Map, gate results per node, Team panel, English-only test extended to the planner/worker prompts.

## Verification plan

Tests first (red, then green), fake agent only: plan validation (cycles, overlap, bad paths, too many pieces); the scheduler never exceeds 3 workers and never runs overlapping pieces together; a red worker gets one repair with the verify output and then fails the piece; a conflict stops and is reported, nothing is merged half way; the approved digest is enforced (changed plan = not approved); a diff outside `files` fails `scope`; a deleted/weakened test fails `quality`; a case without a test fails `qa`; a missing gate command blocks unless waived; the graph gate fails on a stale graph; no hub secret reaches a worker; no push. UI: checked in the built-in browser in four themes and at 375 px. **Cannot be verified here:** a real signed-in CLI as planner/worker, the real size of the cost, Playwright on a real project.

## Left to the builder

File layout under `src/orch/`, the exact JSON schema field names, the wording of the English prompts for planner and worker (kept English, tested), the panel layout of the approval screen (tokens and rules from AGENTS.md), how the scheduler queues pieces.

## Decisions added after the builder check (all **[call]**, change any of them)

1. **A piece fails (red after its one repair, `scope`/`security`/`qa`/`quality` failure, or a conflict).** The orchestration **pauses** in status `needs-decision`: pieces already running finish, no new piece starts, and nothing that `needs` the failed piece starts. The person chooses per failed piece: retry (one more repair budget), drop it (its dependents are dropped too and listed), or stop. The hub never hands over a partial branch as `ready` on its own; after a "drop" the branch is `ready` and the dropped pieces are listed on it.
2. **A failure found on the integration branch** (whole-branch gates or the review gate after merging). One **fixer run** (permission `edit`, Opus) starts in the integration worktree with the failing output, as a normal hub run (`parent_run` = the orchestration's root run, `spawn_reason: 'integration fix'`); one repair per gate round, then `needs-decision`. Findings are not sent back to merged workers.
3. **Gates per piece, before its merge:** `tests`, `scope`, `quality` (size, weakened tests), `security` (built-in diff scan and the approved security argv), `qa` (cases mapped to tests). A failure of `tests`, `scope`, `security` or `qa` counts as red and uses the piece's **one repair** (the worker gets the gate's output). A `quality` size failure goes back to the planner (one re-plan, with the person's approval). **Gates on the integration branch as a whole, after each merge:** all of the above again plus the project's e2e command and `graph`; then once at the end the review gate.
4. **Where it runs.** The orchestration loop runs **in the server process** (it owns the RunManager and the panel); `hub orchestrate "<goal>"` asks the running server to plan, and refuses with the exact command to start the panel when it is not running. Approval is **only** the panel click (the CLI prints the link). A state file left `running` after a restart is marked `stopped (interrupted)` at server start (as runs are); the person may resume it with one click: finished and merged pieces stay, unfinished pieces start again from the integration tip.
5. **Where a piece starts from.** The integration branch is created from the person's HEAD **when the plan is approved** and that commit is pinned in the state file. A piece with no `needs` and no overlap starts from that commit; **a piece that `needs` another, or is sequenced because of overlap, starts from the integration tip after its predecessors are merged** (so it waits for the merge, not just for green). This replaces "from the current HEAD" for such pieces.
6. **Review gate.** The **full ADR-019 machinery is reused unchanged** (hunters and verifiers, the existing round limit, the human approval of the exact commit), run once on the final integration tip; it needs a run row to hang on, so the orchestration's root run is a **synthetic orchestrator run** row (`work_mode: 'orchestrator'`, no agent process; left out of cost and routing stats like reviewer runs). The person therefore touches it **three** times: approve the plan, approve the review, merge into their own branch (the first sentence of "Intent" says two decisions: read it as "plan" and "final merge"; the review approval is the gate in front of the final merge).
7. **Gate commands.** Proposals (from `package.json` scripts and the project's `hub.json`) are shown **on the plan approval screen**; approving the plan approves those exact argv, pinned by digest, and the approval is stored in the hub home folder (with the existing approvals), keyed by project and digest. **The hub never writes `hub.json` or any file of the person's repository** for this. A changed command needs a new approval.

## Open questions for the user

1. **[open 1]** Playwright for this repository: propose as a dev dependency in a separate task, or keep browser-session checks? (The hub works either way.)
2. **[open 2]** Graph on the integration branch: option (a) recommended, or (b)?
3. **[open 3]** Size limits (400 changed lines / 12 files per piece, 400 lines per source file): keep or change the numbers?
