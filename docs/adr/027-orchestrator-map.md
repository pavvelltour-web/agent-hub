# ADR-027: the orchestrator map reads what the hub already stores; hub runs can be messaged, native sub-agents cannot; steps go to a journal; modes teach rules

Status: built (Stage 1 of `docs/superpowers/specs/2026-10-28-orchestrator-map-design.md`, approved by the user on 2026-10-28). Tested with the fake agent. **Not verified live:** the real shape of Claude's `Task`/`Agent` and background-shell events and of `parent_tool_use_id` on a signed-in CLI; whether a sub-agent's own lines carry its model and usage; Codex ignoring a mode's skill list.

## Decisions

- **The map is a read of stored data.** `buildMap` (`src/run/map.ts`) builds a tree from `run` rows (`handoff_of`, `resume_of`, `parent_run`), cascade state files and `turn` rows. Nothing is stored for the tree. Roots are runs nothing started (orchestrators); a cycle in the links ends with each run shown once; the output is capped (300 nodes by default, 1000 at most) and says how many were left out.
- **Two things the hub sets itself.** `run.parent_run` and `run.spawn_reason` are written only by the review gate (`StartReq.parentRunId/spawnReason`, internal; the API never forwards them). Without them reviewer runs could not be tied to the run they review.
- **Native sub-agents and background shells** come from the stored `tool` events of a run (`extractNative`): a `Task` or `Agent` call finished by its result; a `Bash` call with `run_in_background`, stopped by a `KillShell` naming its id. Sub-agent lines now carry `parent` (the tool call id) on tool, tool_result and text events. Their context is shown as **not measured**: the parser still ignores sub-agent token usage (ADR-018/024).
- **Who can be messaged.** A finished hub run with a session id, not a reviewer: `POST /api/map/message` resumes it (`RunManager.start({ resumeRunId })`, so the breaker and the concurrency cap apply). The route needs the panel's own click (`meta.userAction`) on top of the cookie. A native node has no channel: the text goes to the run that owns it, prefixed with the node's name. The route refuses a live run, a run without a session, a reviewer run, and a node that does not belong to the run.
- **Rules by mode.** Each mode names `rules/modes/<mode>.md`; `applyWorkMode(..., { withRules: true })`, set only by the real start route, puts them first in the prompt between `[mode rules: <id>]` markers (after a slash command the hub added, so `/autopilot` and `/grill-me` stay first). They are **not** written into the project's `AGENTS.md`: editing that file clears the prompt cache of every later session. Skills by mode were already there (ADR-020); for Codex they are not restricted by the hub.
- **Step journal.** Every run appends start/handoff/spawn, end and verify lines to `<hub home>/journal/<project id>/<task>.jsonl` (redacted, one line, 1 MB cap with one marker). The hub never writes it into a project by itself: `GET /api/journal` previews `specs/<task>/steps.md` and `POST /api/journal/apply` writes it only with the panel's click and the digest of the shown text, through `applyPlan` (backup and undo).
- **English for agents.** A test (`src/lib/english-only.test.ts`) fails on Cyrillic in what an agent reads: rules, templates, the tool catalog, mode prompt prefixes, stage starter prompts, starter data except the person-facing `why` and `note`. `REVIEW.md` headings are now English; the Russian headings of older files are still read.

## Consequences

- Changed on purpose: assertions that pinned the Russian `REVIEW.md` headings and the rule line; `server.test.ts` now expects the mode's rules block before the mode prefix in a stored prompt.
- A run's stored prompt now contains the rules block; the map and the journal strip it to show the user's own words.
- The map covers hub-started runs and what their event logs show. It cannot show a sub-agent the CLI never reported.

## Not done in Stage 1

- MCP servers of a run as map nodes (the lean tool plan is not stored per run) and the scheduler's items as hub-job nodes; only the graph update is shown as a hub job.
- Stage 2: an orchestrator mode in which the hub splits a plan and starts workers (needs its own design, an ADR and an Opus review of the diff).
- Agent-facing Russian text inside code (prompts built in `src/`), outside the data files the test scans.
