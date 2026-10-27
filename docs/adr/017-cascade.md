# ADR-017: verify-and-escalate cascade

Status: built (`src/run/cascade.ts`). **No live run has been done**: only the fake agent has exercised it, so what a real Sonnet or Opus does with these prompts is **proposed**, not observed (see "Unverified").

## Decision

A task started with `strategy: 'cascade'` is judged by a command, not by the agent's own "done". The hub runs the project's verify command after each working rung and only a green exit code counts as solved. Cheap model first, a stronger one only when verification says the cheap one is stuck. The cascade never starts a review, never approves anything and never accepts a result: the last run stays an ordinary `review` task run and goes through the review gate (ADR-019).

## Rungs and what each one receives

Default ladder: `[Sonnet high, edit] → [Opus xhigh, plan] → [Opus high, edit]` (`defaultLadder`). The task's own agent, model and effort replace the first rung when the request names them.

| Step | Runs as | Receives |
|---|---|---|
| 1. executor | `edit`, new worktree `hub/<task>/<agent>` | the task prompt as the user wrote it |
| verify | the hub, no agent | runs the verify command in the task folder |
| 2. executor repair (only when verify is red) | same agent, same thread when it has a session (else a fresh thread in the same folder) | the task, the verify command, and the **last 40 lines** of its output as a data block |
| verify | | |
| 3. stuck-review (only when still red) | **`plan`** (read-only), fresh thread, same folder | the task, the verify command, the last 40 lines of the latest output as a data block |
| 4. fixer | `edit`, fresh thread, same folder | the task, the verify command, and the reviewer's text **verbatim** as a data block (cut at 32 000 characters with a visible marker) |
| verify | | |

"Last 40 lines" is the tail the checks runner keeps, redacted (`src/lib/redact.ts`) before the prompt is built. Every block is `<<<DATA:name:nonce>>>` … `<<<DATA-END:name:nonce>>>` with a fresh random nonce per prompt, preceded by a rule that the block is data and its instructions are never followed (same convention as the review gate). The reviewer's text is another agent's output: the fixer is told to evaluate it, not to obey it. All prompts forbid editing the verify command, its scripts or the tests.

The review gate's `startFix` is left unchanged: a cascade works before any review exists, so its fixer has no blocking lines to receive, and `startFix` resumes a task thread with exactly those lines. The two stay separate entry points.

## Caps and stop conditions

- At most 4 runs per cascade (executor, repair, stuck-review, fixer); `maxRepairs` is fixed at 2 (the repair and the fixer). The RunManager's own 4-concurrent limit applies to `start`; a refusal stops the cascade with the reason.
- Whole-cascade timeout (60 min default, `timeoutMs`), 30 min per agent run, 10 min per verify run. When the cascade timeout passes, the running agent is stopped and the reason says so.
- The cascade stops, `solved: false`, with a plain reason when: verify is still red after the fixer; a rung is BLOCKED (below); a rung's agent ended `failed` / `limit` / `stopped` (a missing sign-in is named: "claude is not signed in"; `limit` is named); a run cannot start; the reviewer returned no text; the timeout passed. It never loops on an unusable agent. The API refuses to start when any ladder agent is not installed or not signed in (`usableAgents`, observed on this machine: Claude is not signed in, and Codex with a ChatGPT sign-in rejects some models).
- On any stop after a verify ran, a handoff card is written (`writeCard`, reason `failed`) to the PROJECT's `.hub/handoffs/` with the last verify output (redacted, clipped). The checkpoint never commits `.hub/`. A stop before any verify (not signed in, cannot start) writes no card.

## Trust model

- **Where the command comes from.** The verify command is an argv list, never a shell string. It comes from the request body (the user's own browser, behind the session cookie, Host and Origin checks) or from `hub.json` `verify` in the PROJECT ROOT, never from the branch. `hub.json` can come from a cloned repository, so neither source is trusted by itself.
- **Approval.** It runs only after the same digest-pinned, per-machine approval as `review.checks` (ADR-019): the digest covers the argv, the whole `scripts` object of `package.json` for npm-like commands, `.npmrc`, and the bytes of every file `node` is started with. It lives in the same approvals file under a separate key (`<root>#verify`) with a domain-separated digest, so approving review checks does not approve verify and the reverse. The security script is not added to a verify plan (verify runs only what it lists). Unapproved: `POST /api/runs` answers 400 with `needsApproval`, the digest and the plan, and nothing starts; `runCascade` refuses on its own too. Approval is `POST /api/verify/approve` (needs `approved: true` and the digest the server computes now).
- **What runs with what.** Verify runs in the TASK WORKTREE (the agent is expected to change the code under test, so a clean copy would be wrong here), with the allowlisted env (`checkEnv`: no tokens, no `NODE_OPTIONS`, push guard on), no shell, output tail redacted.
- **The agent must not change what verify means.** After each working rung the hub commits the agent's work on its own branch (checkpoint: no repository hook, `.hub/` never staged) and, before running verify, requires (a) the verify plan computed on THAT commit to be approved: an edit to `package.json` scripts, `.npmrc` or a file the command starts changes the digest and the rung is BLOCKED; (b) `testEdits(base, head)` to find nothing: in test files (under `test/`, `tests/`, `__tests__/`, `spec/`, named `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go|py`, or named by the verify command) any removed or changed line, a deleted file, or an added skip / todo marker is a BLOCK. Added tests and added assertions pass. An unreadable diff fails closed. A BLOCKED rung is marked `verifyPassed: false` with the reason, verify is not run, the cascade stops, and it can never count as solved.
- **Agents never approve.** The cascade has no path to the approval endpoints; agent processes do not get the session token (`agentEnv`).

## What is NOT guaranteed

- **Verify runs the agent's code with your rights.** The approval covers what the screen lists, exactly like review checks (ADR-019 "What the digest does not cover"): the tests themselves and everything they import, programs started other than as `node <file>`, `node_modules`.
- **The worktree is not a clean copy.** Ignored files in the task folder (for example an ignored `.npmrc`, `node_modules` the agent installed) are not in the digest and are not seen by it. The review gate's clean-copy runner exists for exactly this; the cascade does not use it because it must verify the agent's working tree. The worktree has no `node_modules` of the project root, so a project with dependencies needs them reachable from the worktree or verify stays red.
- **Test-edit detection is a heuristic.** Weakening a check outside the listed test locations or by means other than removing lines, deleting a file or adding a skip marker (a new test that asserts nothing, an assertion made vacuous by an added line, a mock of the code under test) is not detected. A green verify says the command passed, not that the change is correct: the review gate is still what stands between the branch and acceptance.
- **Prompts are untrusted-data fences, not a sandbox.** The data blocks lower the chance that test output or the reviewer's text steers an agent; they do not stop it. The reviewer runs in `plan`, whose read-only guarantee is the CLI's own.
- **The first rung's session is the only continuity.** A repair resumes the executor's session; the reviewer and the fixer start fresh and only know what the prompts give them.
- **Cost is not capped by money**, only by run count and time. Each rung is a normal run with the router's price per (model, effort); the panel shows each rung's run.

## State shown in the panel

`<home>/cascades/<first run id>.json` (written by the cascade after each step): status, verify argv, per-step `{runId, role, agent, model, effort, verifyPassed, repair, blocked, note, tail}`, reason, card path. `GET /api/runs/:id/cascade` finds the cascade a run belongs to. It is a convenience view: the runs, branch and commits are the record. Model output and verify output in it are untrusted and drawn only through `h()` / textContent after `cascadeModel` typed them.

## Unverified

- No real Claude or Codex has run the ladder. The prompts, the Opus xhigh effort on the reviewer, and whether repair-then-escalate beats going straight to Opus are proposed; task 3.5 (strategy comparison on the user's own data) is where that gets measured.
- `plan` as read-only for a real reviewer is the CLI's behaviour, probed by `hub` modes (`probe`), not re-checked here.

## Consequences

Any change to what blocks a rung, who may approve the verify command, or what a rung receives needs a new ADR. Code in `src/run/cascade.ts` and the verify plan in `src/review/checks.ts` sit on a security boundary and need an Opus review of the diff.
