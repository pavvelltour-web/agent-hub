# ADR-017: verify-and-escalate cascade

Status: built (`src/run/cascade.ts`). **No live run has been done**: only the fake agent has exercised it, so what a real Sonnet or Opus does with these prompts is **proposed**, not observed (see "Unverified").

## Decision

A task started with `strategy: 'cascade'` is judged by a command, not by the agent's own "done". The hub runs the project's verify command after each working rung and only a green exit code counts as solved. Cheap model first, a stronger one only when verification says the cheap one is stuck. The cascade never starts a review, never approves anything and never accepts a result: the last run stays an ordinary `review` task run and goes through the review gate (ADR-019).

## Rungs and what each one receives

Default ladder: `[Sonnet high, edit] → [Opus xhigh, plan] → [Opus high, edit]` (`defaultLadder`). The task's own agent, model and effort replace the first rung when the request names them.

| Step | Runs as | Receives |
|---|---|---|
| 1. executor | `edit`, new worktree `hub/<task>/<agent>` | the task prompt as the user wrote it |
| verify | the hub, no agent | runs the verify command in a clean copy of the checkpoint commit |
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
- **What runs with what.** After each working rung the hub commits the agent's work on its own branch (checkpoint) and runs verify in a CLEAN COPY of that commit (`exportCommit`). The copy is written by the hub from `git ls-tree` + `git cat-file --batch`: raw blob bytes, with NO filter, textconv, eol conversion or attribute, so a smudge filter named in `.git/info/attributes` or `core.attributesFile` and defined in the repository config can neither change the copy nor run a command. Every path is checked to stay inside the copy (no empty, `.`, `..`, `.git` segment, backslash, drive letter or reserved Windows name); a symlink entry becomes a plain file holding its target text (never a link); a submodule is skipped; a commit over 200 MB or 50 000 files is refused. No ignored files, no skip-worktree edits, no branch `node_modules` (the PROJECT ROOT's is linked in). The bytes that run are the bytes that were judged. Env is the allowlisted `checkEnv` (no tokens, no `NODE_OPTIONS`, push guard on), no shell, output tail redacted.
- **The agent must not change what verify means.** The checkpoint is atomic or it fails: a failed `git add`, a refused commit, or a working tree that is not clean afterwards (outside `.hub/`) returns a note. Right after an agent run that is the AGENT's doing (a locked index, a nested repository, an unreadable file): the rung is BLOCKED, `verify_passed` = 0. The checkpoint's own git calls run with `agentConfigGuard`: no attributes file, no fsmonitor, every `filter.*` of the repository and user config emptied (a filter with no command does nothing). That is a defence, not a proof: the task folder's `config` is the agent's to write, and any other config key that runs a program on `add` / `status` / `commit` would have to be added to the guard. Before verify runs the hub requires: (a) `HEAD` is `refs/heads/<the run's branch>` (work moved to another branch or a detached HEAD is BLOCKED, and nothing is committed there); (b) no assume-unchanged or skip-worktree index entries (skip-worktree is allowed in a sparse checkout, where it is normal); (c) the verify plan computed on THAT commit to be approved: an edit to `package.json` scripts, `.npmrc` or a file the command starts changes the digest; (d) `testEdits(base, head)` to find nothing, reading paths from `git diff --name-status/--numstat -z` (never from diff headers, which git quotes for non-ASCII names). Test files (under `test/`, `tests/`, `__tests__/`, `spec/`, `__snapshots__/`, `fixtures/`, `testdata/`, an `expected*` path; named `*.test.*`, `*.spec.*`, `test-*.js`, `*-test.js`, `*_test.js`, `test.js`, `*.snap`, `test_*.py`, `*_test.go|py`; or named by the verify command): any removed or changed line, a deleted file, an added skip / todo / only / focus marker, an added early exit (`process.exit`, `process.exitCode =`, `os._exit`, `sys.exit`, `Deno.exit`, `exit(...)`, a bare top-level `return`). Runner and build configuration: any change to jest / vitest / vite / playwright / cypress / ava / karma config files, babel config, `.mocharc*`, `pytest.ini`, `conftest.py`, `tox.ini`, `setup.cfg`, `pyproject.toml`, `tsconfig*.json`, nyc / c8 config, and to the `scripts` or runner keys (`jest`, `vitest`, `mocha`, `ava`, `tap`, `c8`, `nyc`, `babel`) of ANY `package.json`, at any depth. Added tests and added assertions pass. An unreadable diff, a failed listing of the index, or a copy that cannot be written is a HUB-SIDE failure: shown as "not verified", `verify_passed` stays NULL, no verdict on the model. An agent-caused BLOCK marks the rung `verifyPassed: false` (`run.verify_passed` = 0), verify is not run, the cascade stops, and it never counts as solved.
- **Agents never approve.** The cascade has no path to the approval endpoints; agent processes do not get the session token (`agentEnv`).

## What is NOT guaranteed

- **Verify runs the agent's code with your rights.** The approval covers what the screen lists, exactly like review checks (ADR-019 "What the digest does not cover"): the tests themselves and everything they import, programs started other than as `node <file>`, `node_modules`.
- **Not a verdict on the live folder.** Verify judges the committed checkpoint in a clean copy, not what is lying in the task folder: files the agent left uncommitted or ignored are not part of it (that is the point). The copy has the project root's `node_modules`, not the branch's: a branch that needs a dependency not installed in the root stays red until the user installs it there.
- **Test-edit detection is a heuristic, not a proof.** Added lines in test files are otherwise trusted, and what the lists above do not name is not seen: a new test that asserts nothing, an assertion made vacuous by an added line, a mock of the code under test, a test helper outside the named locations that always passes, an exit hidden behind an alias or a different runtime, weakening a data file that is not under a named fixtures path. A green verify says the command passed, not that the change is correct: the review gate is still what stands between the branch and acceptance.
- **Prompts are untrusted-data fences, not a sandbox.** The data blocks lower the chance that test output or the reviewer's text steers an agent; they do not stop it. The reviewer runs in `plan`, whose read-only guarantee is the CLI's own.
- **The first rung's session is the only continuity.** A repair resumes the executor's session; the reviewer and the fixer start fresh and only know what the prompts give them.
- **Cost is not capped by money**, only by run count and time. Each rung is a normal run with the router's price per (model, effort); the panel shows each rung's run.

## State shown in the panel

`<home>/cascades/<first run id>.json` (written by the cascade after each step): status, verify argv, per-step `{runId, role, agent, model, effort, verifyPassed, repair, blocked, note, tail}`, reason, card path. `GET /api/runs/:id/cascade` finds the cascade a run belongs to. It is a convenience view: the runs, branch and commits are the record. Model output and verify output in it are untrusted and drawn only through `h()` / textContent after `cascadeModel` typed them.

## Quality evidence (task 3.4)

Each working rung's run stores `run.verify_passed` (1 green, 0 red or BLOCKED, NULL = no verify judged it: the read-only reviewer, every run outside a cascade). `runScore` orders evidence: the user's rating > the verify result (green 0.9, red 0.1) > the outcome (`done` without any verify 0.5, down from 0.7; `failed` 0; limit, stop and a pending review are no evidence). A verify result outranks a pending review but never a rejected one: if the review ends `reconsider`, or one of the gate's clean-copy checks was red, a verify pass is capped at 0.1. Consequence for learned routing: with the blend of 5 prior runs, a model whose history is only unverified `done` now measures below its prior (implement/Sonnet: prior 0.80, ten unverified done runs: 0.73 before, 0.60 now) until its runs carry verify results.

## Unverified

- No real Claude or Codex has run the ladder. The prompts, the Opus xhigh effort on the reviewer, and whether repair-then-escalate beats going straight to Opus are proposed; task 3.5 (strategy comparison on the user's own data) is where that gets measured.
- `plan` as read-only for a real reviewer is the CLI's behaviour, probed by `hub` modes (`probe`), not re-checked here.

## Consequences

Any change to what blocks a rung, who may approve the verify command, or what a rung receives needs a new ADR. Code in `src/run/cascade.ts` and the verify plan in `src/review/checks.ts` sit on a security boundary and need an Opus review of the diff.
