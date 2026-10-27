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

Every Important and Security finding ends as `fixed`, `rejected` or `intentional` (both require a reason), or `dismissed` (requires a reason for Important and Security). `open` is the initial state, never a valid answer, and only an open finding can be answered. Any open security finding blocks.

`fixed` is set automatically only when the flagged line (compared without whitespace, quote style or a trailing comment) is gone from every tracked file of the new head (`git grep` on the commit): moving the file or a cosmetic edit does not clear it. A security finding is never cleared automatically; it needs a human answer.

## What the gate reads (integrity rules)

- The review belongs to the branch (project + branch + folder), not to a run: a fixer or resumed run continues the same review, its rounds and its `reconsider`.
- Every diff is `git --attr-source=<empty tree> diff --text --no-renames --no-ext-diff --no-textconv`: a branch `.gitattributes` (`* -diff`, drivers) cannot hide hunks, and a `git mv` shows as delete + add.
- "Pre-existing" means not added anywhere in base..head (the round's own diff only decides what the reviewers look at). A hunter's line may be off by up to 3 lines; paths are normalised (`a/`/`b/`, `./`, backslashes, absolute under the repo, case on Windows).
- The security pass is verified first. Findings beyond the verify cap (30) keep the review `open` with the dropped count, and the next round starts from the same commit.
- A diff longer than the reviewers' limit (200 000 characters) makes the branch need a human approval from then on (`needs-human`, "diff too large to review fully").
- A hunter answer whose findings all fail the schema, with more findings than the schema allows, or with an empty list quoted mid-text instead of given as the answer, is "no review".
- Reviewers start in a fresh empty folder (removed after) and get the diff as text: the branch's CLAUDE.md, AGENTS.md, `.claude` settings and hooks never load.
- Accept decisions (`can-accept`) read HEAD and a clean tree from git in the task folder; a sha from the client is only compared. An approval is accepted only when the review is not running or in `reconsider` and its last finished round covered exactly that head.
- A review is refused while any run is still working in the branch folder. A round cut off by a hub restart is `open` with "interrupted by a restart" and can be run again.

## Convergence

- Round cap 3. After round 3 the state becomes `reconsider`: the approach is questioned, not patched again. Re-checking with no new commit is answered first ("nothing new") and never turns a finished review into `reconsider`.
- Later rounds review only the new diff (diff-only re-review).
- A finding is identified by a fingerprint of normalized file path + whitespace-normalized text of the line + class of bug (title only when the class is absent). The line number is not part of it, so moving code does not make a finding new. Repeats are dropped only against the same review (the branch), and never against a `fixed` finding: a bug that comes back is reported again.

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
