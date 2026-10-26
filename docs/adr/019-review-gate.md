# ADR-019: mandatory review gate with verifier votes; only a human approval counts

Status: decided for the data model (PR.1). The pipeline stages that use it (PR.2 onward) are not built yet, and **no live reviewer run has been done** (see "Unverified").

## Decision

No task branch is accepted ("Accept result" / merge into the project) while its review gate is open. The gate sits between "agent finished" and "accept". It is not an option the user switches on per task; only the effort level (quick / standard / deep) is a setting.

The gate covers everything the agent created, not only code: source, tests, configs, migrations, docs, `AGENTS.md` and rules files, dependency changes, generated files, and UI (rendered screenshots).

A review runs in rounds: checks (tests, typecheck, lint, build, secrets scan, dependency audit; red closes the gate and no AI review is spent) → parallel hunters, one lens each → verifiers → filter → separate security pass → risk tier → answers → converge.

## Why verifier votes

Hunters are noisy: a single reader reports plausible-looking bugs that are not real. Each finding is therefore checked by K independent verifiers (1 / 2 / 3 for quick / standard / deep) and kept only when a majority says "real". Style, cleanup and diagnostic findings are dropped before anything is shown; what remains is tagged Important, Nit (at most 5 shown), Pre-existing, or Security.

The design follows the vendor blog "Solving code review at Anthropic" (claude.dev). Its numbers (one-round pass 65 % to 78 %, mean rounds 2.08 to 1.32, about 59 % of repeat flags on pre-existing code) are **reported by the vendor, not measured here**. They are priors that justify trying the design, not results of this hub. The hub's own eval set (incidents and reverts) has to confirm or reject them.

## Why an agent approval never counts

A human approval is bound to one commit sha (`humanApproval = { sha, at }`). Any new commit makes it stale and it is dropped (`clearHumanApproval`). An approval that comes from an agent run, including the reviewer's own, is ignored: only the user can approve, and high-risk changes need it. Agents may argue, verify and fix; they do not sign off.

## Findings are answered, not ignored

Every Important and Security finding ends as `fixed` (cleared automatically by a later commit, recorded in `clearedBy`), `rejected` or `intentional` (both require a reason), or `dismissed`. `open` is the initial state, never a valid answer. Any open security finding blocks.

## Convergence

- Round cap 3. After round 3 the state becomes `reconsider`: the approach is questioned, not patched again.
- Later rounds review only the new diff (diff-only re-review).
- A finding is identified by a fingerprint of normalized file path + whitespace-normalized text of the line + class of bug (title only when the class is absent). The line number is not part of it, so moving code does not make a finding new. Fingerprints already stored for the project are used to drop repeats.

## Data model

Types in `src/review/types.ts`, functions in `src/review/store.ts`, tables `review` and `finding` in the history database (`src/history/store.ts`, created with `CREATE TABLE IF NOT EXISTS`, so existing databases gain them in place; no data is touched).

- `Review`: id (`rv…`), runId, projectId, baseSha, headSha, effort, risk, round, state (`checks | hunting | verifying | open | passed | needs-human | reconsider`), optional humanApproval.
- `Finding`: id (`fd…`), fingerprint, reviewId, round, severity, lens, file, line, title, evidence, classOfBug, votes `{ real, notReal }`, answer, reason, clearedBy.
- `RawFinding` (hunter output, includes `category`) and `VerifiedFinding` (plus votes) are pipeline types; only verified, filtered findings are stored.

## Unverified

- Live reviewer runs need signed-in `claude` and `codex` CLIs. Today only the fake agent can exercise the pipeline, so hunter quality, the vote threshold, cross-vendor diversity and the cost per round are **proposed**, not observed.
- The effort table (hunters and verifiers per level) and the model choices come from the plan; they are not tuned.

## Consequences

PR.2 onward builds the stages on this model. Any change to the gate's rules (what blocks, who may approve) needs a new ADR. Security-boundary code in this area needs an Opus review of the diff.
