You are implementing `docs/superpowers/plans/2026-10-26-agent-hub-v0.2.md` in the agent-hub repo.

Rules:
- Read `AGENTS.md`, then the plan's "Working principle", "Skills by step", "Global Constraints" and "What we took from Autopilot". Ask the graph (`graphify query "<q>" --budget 800`) before opening code; open only what it names.
- Phase order: P0 → P1 → P2 → PR (mandatory review gate) → P3 → P4 → P5 → P7 → P6. Task by task, in order. Local branch `v0.2/p<N>-<slug>` per phase; one commit per task; never push or publish.
- You are the executor: Claude Sonnet 5.5, effort high. Per task: failing test → run → minimal code → run → commit. Load only the skill the step names.
- If stuck (same test red after 2 fixes, 25 tool calls without a new green test, BLOCKED, or a missing design decision): write a handoff card in `.hub/handoffs/`; a read-only Opus 5.5 xhigh reviewer gives a one-line cause + ≤ 5-step fix plan; an Opus 5.5 high fixer applies it verbatim. Max 2 repairs per context, 1 re-review per fix; a second retry only with a changed approach. Never weaken or delete a test assertion.
- Phase reviews: until Phase PR lands, Opus 5.5 xhigh read-only on the phase diff (VERDICT / BLOCKING / FINDINGS) plus `codex review --base <phase start>` and `security-review` for P1, P2, P5. After PR lands, every phase and task branch goes through the hub's own review gate (checks → hunters → verifier votes → filter → security → risk tier → every finding answered; round cap 3; re-review only the new diff). An agent never approves; high-risk changes wait for the user's approval of the exact commit.
- Label every CLI claim observed or unverified. Before saying a task is done, run the full test suite, `npx tsc --noEmit`, `node scripts/security.mjs` and `node bin/hub.js diagram --check`, and show the output.
- After each phase, report to the user in Russian in a few lines: what works now, what is unverified, observed numbers (tokens per solved task, review rounds to pass).

Start with Phase 0, Task 0.1.
