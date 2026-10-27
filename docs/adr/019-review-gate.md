# ADR-019: mandatory review gate with verifier votes; only a human approval counts

Status: built through PR.8 (data model, gate pipeline with checks and convergence, REVIEW.md rules, review screen, reviewer evals, gate integrity, trust model for checks). **No live reviewer run has been done** (see "Unverified").

## Decision

No task branch is accepted ("Accept result" / merge into the project) while its review gate is open. The gate sits between "agent finished" and "accept". It is not an option the user switches on per task; only the effort level (quick / standard / deep) is a setting.

The gate covers everything the agent created, not only code: source, tests, configs, migrations, docs, `AGENTS.md` and rules files, dependency changes, generated files, and UI (rendered screenshots).

A review runs in rounds: checks (approved list only, see "Trust model": tests, typecheck, security script, secrets scan, dependency licenses; red or unapproved closes the gate and no AI review is spent; a project with no tests or type check gets the warning "Нет проверок" and is never low risk) → parallel hunters, one lens each → verifiers → filter → separate security pass → risk tier → answers → converge.

## Why verifier votes

Hunters are noisy: a single reader reports plausible-looking bugs that are not real. Each finding is therefore checked by K independent verifiers (1 / 2 / 3 for quick / standard / deep) and kept only when a majority says "real". Style, cleanup and diagnostic findings are dropped before anything is shown; what remains is tagged Important, Nit (at most 5 shown), Pre-existing, or Security.

The design follows the vendor blog "Solving code review at Anthropic" (claude.dev). Its numbers (one-round pass 65 % to 78 %, mean rounds 2.08 to 1.32, about 59 % of repeat flags on pre-existing code) are **reported by the vendor, not measured here**. They are priors that justify trying the design, not results of this hub. The hub's own eval set (incidents and reverts) has to confirm or reject them.

## Why an agent approval never counts

A human approval is bound to one commit sha (`humanApproval = { sha, at }`). Any new commit makes it stale and it is dropped (`clearHumanApproval`). Approvals come only from the panel's approve endpoint, and the only thing that separates the user's browser from other callers is the session cookie/token (see "Trust model"): the hub's agent runs never get it, so they cannot approve through the hub. There is no separate check that recognises and drops an "agent-made" approval. High-risk changes need the approval. Agents may argue, verify and fix; they do not sign off.

## Trust model

Plainly, what is and is not protected:

- **Where approvals live.** Review approvals, finding answers and reviews are rows in `~/.agent-hub/hub.db`; check approvals are `~/.agent-hub/review-checks-approved.json` and runner-hook approvals `~/.agent-hub/hooks-approved.json`. Any process running as the same OS user can write these files and forge an approval or an answer. That includes the code the checks run (branch scripts, `node_modules`) and a Claude/Codex run in `edit`/auto mode that decides to edit them.
- **What the structural guard does.** The hub's own agent processes are started without the session token or cookie variables (`agentEnv`) and with `git push` blocked (`pushGuardEnv`). So they cannot call the approve endpoints through the hub's HTTP API, which checks the cookie, the Host and the Origin. That is all it does: it is not a sandbox and does not stop direct file writes.
- **Checks run branch code with the user's rights.** `npm test`, `npm run typecheck`, `scripts/security.mjs` and any `review.checks` from `hub.json` execute code the agent may have written, outside the agent's sandbox. Therefore they run only after the user approved exactly that list on this machine: a sha256 digest over the argv lists, the whole branch-head `package.json` `scripts` object (when an npm-like check runs), `.npmrc`, and the bytes of every file node starts — from the argv and from the scripts the checks reach (`npm run x` inside scripts is followed with npm's pre/post, 3 levels deep; `-r/--require/--import/--loader/--env-file` values that are paths count; option values and package names such as `tsx` do not). Unapproved or changed: nothing runs, the review is `open` with "Проверки из hub.json не одобрены" (or `package.json` / `scripts/security.mjs`), and the screen shows the list with «Одобрить проверки». The approval route needs `approved: true` and the digest the server computes at that moment.
- **The screen shows every byte the digest covers.** Commands, ALL scripts and the file hashes are sent and drawn in full (scrollable `<pre>`, textContent); nothing is cut. If that content is over 64 KB the server refuses to build an approvable plan ("Список проверок слишком большой…") instead of showing a cut list.
- **Checks run the bytes the digest covers (decision for B4).** Two options were weighed: compare the task folder with the commit before running (`ls-files -v` flags, ignored files), or run in a clean copy. We chose the **clean copy**: the head commit is written with its own index (`read-tree` + `checkout-index`) to `<home>/check-runs/<id>/tree` and removed afterwards. The copy has no repository hooks, no branch attributes (no eol conversion, no filters, so the bytes equal the blobs) and plain files instead of symlinks. Nothing from the task folder comes along: no ignored files (an ignored `.npmrc` with `node-options`/`script-shell`), no skip-worktree / assume-unchanged edits, no branch `node_modules`. A comparison would have to know every file npm, node and the scripts read; the copy does not. `node_modules` is linked (junction) from the PROJECT ROOT when it has one, so `tsc` and test runners resolve: that is the user's own install, not the branch's, and it is not in the digest (the screen says so).
- **What checks see (env).** An allowlist: `PATH`, `PATHEXT`, `SystemRoot`, `windir`, `SystemDrive`, `ComSpec`, `TEMP`, `TMP`, `TMPDIR`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles*`, `CommonProgramFiles*`, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`, `OS`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `SHELL`, `USER`, `USERNAME`, `LOGNAME`, `TZ`, plus `CI=1` and the push guard (`GIT_CONFIG_*` → a refusing pre-push hook). Never tokens or API keys, `NODE_OPTIONS` or `npm_config_*`.
- **The checkpoint commit runs no hook.** `git add` / `git commit` before a review run with `core.hooksPath` set to an empty folder under the hub home and `--no-verify`, in the allowlisted env: hooks such as husky's are branch files.
- **What the branch cannot change.** `hub.json` `review.checks` and `humanPaths`, and every `REVIEW.md` (root and folder files) are read from the project root, never from the branch. A branch that edits `REVIEW.md`, `hub.json`, check/lint/test-runner configs, `.gitattributes`, `.npmrc`, `.vscode/`, `.devcontainer/`, `.agents/`, `.claude/` or `scripts/security.mjs` is high risk and needs a human. A dependency license is read only from the project root's installed copy (never the task folder's `node_modules`), and only for a plain registry version.
- **Reviewer runs** are plumbing: marked `gate-reviewer`, left out of run lists, econ, model stats and routing, they never write a handoff card, and a checkpoint never commits `.hub/`. They start in `<home>/reviewers/<id>` (removed after; a failed removal is a review warning); history gives their CLI sessions no project and the project list hides them; the panel removes leftovers older than an hour when it starts and prints what it could not remove.
- **Who marks interrupted rounds.** Only the panel process, when it starts (`startServer`); a `hub run` / `hub chat` RunManager on the same database leaves running rounds alone.

### What the digest does not cover (by design)

The digest can never be complete: `npm test` executes the branch's code by its nature. The approval covers only what the screen lists (commands, all `package.json` scripts, hashes of the files node is started with, `.npmrc`); the screen says «Проверки выполняют код ветки … одобрение покрывает только перечисленное». Not covered, and not chased by parsing:

- the tests themselves and everything they (or any listed file) import or read: test files a runner globs, `imports`/`exports` maps, config files read at run time;
- programs started other than as `node <file>`: `cross-env X=1 node …`, `X=1 node …`, `npm-run-all`/`run-p`/`concurrently`, `npx`, shell built-ins, binaries in `node_modules/.bin`;
- `npm run` chains deeper than 3 levels, other package managers' config (`.yarnrc.yml`, `bunfig.toml`, `.pnpmfile.cjs`), user / global npm config;
- `node_modules`: linked from the project root (the user's own install, not the branch's).

### Known limitations (accepted)

- **Writes through the link.** The checks copy links the PROJECT ROOT `node_modules` (junction); a check can write into it. Licences are therefore read before any check runs, and a link is always taken off before a copy is deleted. A committed branch `node_modules/` (at any depth) never comes into the copy.
- **New dependencies.** A branch that adds a dependency not installed in the project root fails its checks until the user installs it there; the approval screen says so.
- **Case-insensitive file systems.** A commit with paths equal but for case (and on Windows reserved names, `:`, trailing dot or space) cannot be copied faithfully: the round closes with that reason instead of running the wrong blob.
- **Unreadable plans.** A branch `package.json` that exists but cannot be read (over 1 MB, not JSON; a UTF-8 BOM is accepted, as npm does) or any file the plan must hash over 16 MB makes the plan unapprovable, and the review stays `open` with that reason.
- **Long lines.** A flagged line longer than 2000 characters (or whose key is shorter than 4) is never auto-closed; a human answers it. The clearing key cuts at the first `//` or `#` anywhere (also inside strings): that errs on the side of keeping findings open.
- **One panel per database.** There is no single-instance guard: a second `hub ui` on the same database marks the first one's running rounds interrupted at start.
- **cmd.exe search order.** Checks get `NoDefaultCurrentDirectoryInExePath=1`, so npm's cmd.exe does not run a `node.cmd`/`tsc.cmd` from the copy's folder before PATH; programs that do their own lookup are not covered.
- Branch `.gitattributes` filters (e.g. Git LFS smudge) are not applied in the checks copy: an LFS file is a pointer there.
- The checkpoint and the git probe in `begin()` stay synchronous (they must finish before the review exists); the round itself starts on a later tick and its git work is asynchronous.
- A RunManager constructor still marks unfinished RUNS (not reviews) of the database as interrupted; a second process can therefore mark the panel's live runs. Not changed here.
- The gate needs Git 2.40+ (`--attr-source`) and SHA-1 repositories; otherwise a review is refused with that message.
- Reviewer CLI sessions stay in the history index (without a project), so their tokens still appear in history usage totals.

## Findings are answered, not ignored

Every Important and Security finding ends as `fixed`, `rejected` or `intentional` (both require a reason), or `dismissed` (requires a reason for Important and Security). `open` is the initial state, never a valid answer, and only an open finding can be answered. Any open security finding blocks.

`fixed` is set automatically only when the flagged line (compared without whitespace, quote style or a trailing comment) is gone from every tracked file of the new head (`git grep` on the commit, for the longest identifier of the line's code part, with user/repository grep config overridden: no line numbers, columns or names in the output): moving the file, a cosmetic edit or removing a trailing comment does not clear it. The stored line is the added line a finding matched (a hunter may be off by up to 3 lines), not the hunter's own number. A security finding is never cleared automatically; it needs a human answer.

## What the gate reads (integrity rules)

- The review belongs to the branch (project + branch + folder), not to a run: a fixer or resumed run continues the same review, its rounds and its `reconsider`.
- Every diff is `git --attr-source=<empty tree> diff --text --no-renames --no-ext-diff --no-textconv`: a branch `.gitattributes` (`* -diff`, drivers) cannot hide hunks, and a `git mv` shows as delete + add.
- "Pre-existing" means not added anywhere in base..head (the round's own diff only decides what the reviewers look at). A hunter's line may be off by up to 3 lines; paths are normalised (`a/`/`b/`, `./`, backslashes, absolute under the repo, case on Windows).
- The security pass is verified first. Findings beyond the verify cap (30) keep the review `open` with the dropped count, and the next round starts from the same commit.
- A diff longer than the reviewers' limit (200 000 characters) makes the branch need a human approval from then on (`needs-human`, "diff too large to review fully").
- A hunter answer whose findings all fail the schema, with more findings than the schema allows, or with an empty list quoted mid-text instead of given as the answer, is "no review".
- Reviewers start in a fresh empty folder (removed after) and get the diff as text: the branch's CLAUDE.md, AGENTS.md, `.claude` settings and hooks never load.
- Accept decisions (`can-accept`) read `refs/heads/<run branch>`, require the task folder to be on that branch (not detached, not another branch) and a clean tree; a sha from the client is only compared. An approval is accepted only when the review is not running or in `reconsider` and its last finished round covered exactly that head.
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
