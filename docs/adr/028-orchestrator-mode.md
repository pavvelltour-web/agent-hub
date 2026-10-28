# ADR-028: orchestrator mode: the hub plans, spawns workers, verifies and merges; agents only write code

Status: **proposed** (design: `docs/superpowers/specs/2026-10-28-orchestrator-mode-design.md`). Not approved by the user yet; no code exists. Changes a security boundary (process spawning, git on agent-controlled branches): needs an Opus review of the diff.

## Decisions (proposed)

- **Only the hub spawns and merges.** A planner run (permission `plan`, read-only) proposes pieces as data; the hub validates the plan, the person approves its digest, the hub starts one worker run (permission `edit`) per piece in its own worktree. No agent starts a process, merges, or pushes.
- **Concurrency.** At most 3 workers at once (the hub-wide cap of 4 live runs stays; the planner uses one slot while it runs). Pieces whose declared files overlap run in sequence. The declared set is checked against the real diff (`scope` gate).
- **Merging.** The hub merges green pieces, one at a time in plan order, into `hub/<task>/integration` in an integration worktree, with the agent-config guard and no hooks. A conflict stops the piece and is shown; no model resolves conflicts. The person merges the integration branch into their own branch. Nothing is pushed.
- **Gates are mandatory and run by the hub in a clean copy of the commit:** tests (required), qa (plan cases mapped to tests, plus the project's own end-to-end command when it has one), security (approved command + built-in diff scan), quality (size limits, weakened-test detector), scope, graph. Commands are approved argv pinned by digest (ADR-017/019 mechanism). A category without a command blocks unless the person waives it in the approved plan.
- **No new dependency.** Playwright is not added to the hub; the project's own e2e command is run when present.
- **Graph in the loop.** Workers get `graphify query` slices from the root graph; after each merged piece the code-only `graphify update` runs in the integration worktree and its output is committed on the integration branch (needs the user's OK because AGENTS.md says never to build a graph copy inside a worktree).
- **Team panel.** Skills, plugins and MCP servers of the project and of each node are listed from data the hub already reads, with the item's own first-sentence description and the person-facing `why` when one exists; "used" is shown only from calls seen in the stored events.
- **State** is a file per orchestration in `<home>/orchestrations/`; runs are indexed in the DB as before.

- **Failures and recovery** (details in the design, "Decisions added after the builder check"): a failed piece pauses the orchestration for the person's choice (retry, drop, stop); a failure on the integration branch gets one fixer run in the integration worktree; dependent or overlapping pieces start from the integration tip; the loop runs in the server process and a restart marks it `stopped (interrupted)`; the review gate is ADR-019 unchanged, hung on a synthetic orchestrator run row; gate commands are approved with the plan and stored in the hub home, never written into the person's repository.

## Consequences (expected)

- New code under `src/orch/` and routes `…/api/orch/*`; Stage 1's map and journal show the new nodes without a new tree builder.
- Every piece costs a worktree and a gate run: orchestration is slower and dearer than one run; it pays only when pieces are independent. The plan states the expected number of runs before approval.
- Size limits make the planner split work; a piece over the limit goes back for one re-plan.

## Not decided / risks

- Real planner and worker behaviour on a signed-in CLI was never observed; the plan's quality is unknown.
- The `qa` mapping (case id → test title) is a heuristic; a test that asserts nothing passes it.
- Cost per orchestration is bounded by the breaker and piece/repair caps but not measured.
