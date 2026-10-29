# Agent Hub: full test plan (for a person to run and report)

This is the protocol for checking the hub **end to end on a real machine**. It covers what the automated tests cannot: a clean install, the panel in a browser, the real Claude and Codex command-line tools, the security behaviour of the local server, and the public repository itself.

How to use it: go part by part, write the result in the **Result** column (`PASS`, `FAIL`, `SKIP`, `BLOCKED`) and a note for anything that is not `PASS`. At the end fill the report form (part I) and send it back with `test-report.md`. **Never paste a real key, token or password into a report.** The test token used below (`TESTTOKEN`) is a throw-away value.

Time: parts 0 to D about 45 minutes. Part E needs signed-in `claude` and `codex` and spends a little of your limit (short prompts). Part F about 15 minutes. Part H about 20 minutes.

Columns: **ID** · **Step** · **Expected** · **Result** · **Note**.
Windows commands are for PowerShell. `curl.exe` (not the `curl` alias) is used on purpose.

---

## Part 0. Before you start

| ID | Step | Expected | Result |
|---|---|---|---|
| 0.1 | `node --version` | `v24` or newer | ☐ |
| 0.2 | `git --version`, `pnpm --version` | git present; pnpm 9.x (`npm install -g pnpm@9` if missing) | ☐ |
| 0.3 | `claude --version` and `claude auth status` (skip if you do not use Claude) | version printed; signed in | ☐ |
| 0.4 | `codex --version` (skip if you do not use Codex) | version printed; signed in | ☐ |
| 0.5 | `docker version` (optional, for the external scanners) | server version printed, or SKIP | ☐ |
| 0.6 | Write down: OS and build, CPU/RAM, which browser, the commit hash you test (`git rev-parse HEAD`) | recorded in the report | ☐ |

Use a scratch folder for everything you create (for example `D:\ah-test`). Do not run the destructive steps in a project you care about.

## Part A. Clean install from GitHub

| ID | Step | Expected | Result |
|---|---|---|---|
| A1 | `git clone https://github.com/pavvelltour-web/agent-hub D:\ah-test\clone` | clones; no error | ☐ |
| A2 | In the clone: `pnpm install --frozen-lockfile` | succeeds; no lockfile change (`git status` is clean) | ☐ |
| A3 | `node bin/hub.js --help` | the command list (Project / Work / History / Panel and checks) | ☐ |
| A4 | `node bin/hub.js --version` | a version number, no stack trace | ☐ |
| A5 | `pnpm build` | exit code 0, `dist/` appears | ☐ |
| A6 | `git status` after A2 to A5 | nothing tracked is changed (`dist/` is ignored) | ☐ |
| A7 | Open `README.md` as GitHub renders it: images show, Mermaid diagrams render, no broken link | all fine | ☐ |
| A8 | Run the same steps from `docs`/README "quick start" exactly as written, nothing more | the README is enough on its own to get a panel running | ☐ |

## Part B. Automated checks

| ID | Step | Expected | Result |
|---|---|---|---|
| B1 | `node scripts/test-all.mjs` (takes about 10 to 15 minutes) | prints PASS per folder, then `Verdict: **PASS**`; writes `test-report.md`. Compare totals with the author's baseline in part I | ☐ |
| B2 | `node scripts/test-all.mjs --only server` three times in a row | PASS three times (this folder used to fail in parallel; see `docs/STATUS.md`) | ☐ |
| B3 | `node scripts/test-all.mjs --only run` three times | PASS three times | ☐ |
| B4 | `node node_modules/typescript/bin/tsc --noEmit` | no output | ☐ |
| B5 | `node scripts/security.mjs` (and with `--docker` if 0.5 passed) | `all 17 checks passed`; with Docker the scanners also run (gitleaks, semgrep, trivy) and find nothing serious | ☐ |
| B6 | `node bin/hub.js diagram arch --check` | `diagrams are up to date` | ☐ |
| B7 | `node bin/hub.js doctor` | an environment report: Node, git, the agent CLIs found or not; no crash | ☐ |
| B8 | Repeat B1 once more on a **loaded** machine (play a video or compile something) | still PASS, or note which test fails and how often | ☐ |

## Part C. Command line without real agents

Run in a scratch folder. Set a separate data folder so your real hub data is not touched: `$env:AGENT_HUB_HOME = 'D:\ah-test\home'`.

| ID | Step | Expected | Result |
|---|---|---|---|
| C1 | `node bin/hub.js new web-saas D:\ah-test\proj1` | shows a **plan** and asks to approve; nothing is written before you answer | ☐ |
| C2 | Repeat with `--yes` | creates the folder, runs `git init`, writes `hub.json`, `AGENTS.md`, `REVIEW.md`; files are English | ☐ |
| C3 | `node bin/hub.js new web-saas D:\ah-test\proj1 --yes` again (folder not empty) | refuses (new or empty folders only) | ☐ |
| C4 | `node bin/hub.js tools D:\ah-test\proj1` | what loads into every turn with token costs; no crash | ☐ |
| C5 | `node bin/hub.js stage D:\ah-test\proj1` | shows the lifecycle stages and which are open | ☐ |
| C6 | `node bin/hub.js estimate --class implement` | a cost and token estimate table | ☐ |
| C7 | `node bin/hub.js init D:\ah-test\proj1 --add <any id from the catalog> ` then `node bin/hub.js undo D:\ah-test\proj1` | init shows a plan and makes a backup; undo restores the previous files exactly | ☐ |
| C8 | `node bin/hub.js sync` | imports Claude/Codex history **read-only**; prints counts; your `~/.claude` and `~/.codex` are unchanged (no file there is newer than before) | ☐ |
| C9 | `node bin/hub.js history <a word you know you used>` | finds the conversation | ☐ |
| C10 | Path hygiene: `node bin/hub.js init "D:\ah-test\папка с пробелом"` (create the folder first) | works with spaces and Cyrillic in the path | ☐ |
| C11 | Names: `node bin/hub.js run "x" D:\ah-test\proj1 --task "a;b" --worktree` | rejected with an "unsafe task or agent name" style message; nothing created | ☐ |

## Part D. The panel (browser)

Start: `node bin/hub.js ui --demo --no-open --port 4777 --token TESTTOKEN --home D:\ah-test\home-demo`, then open `http://127.0.0.1:4777/?t=TESTTOKEN`. The demo uses scripted fake agents (no limit is spent). The History and Tools screens may still list **your real** Claude/Codex data (read-only); to hide it start with `$env:USERPROFILE='D:\ah-test\empty'; $env:HOME='D:\ah-test\empty'` set first.

| ID | Step | Expected | Result |
|---|---|---|---|
| D1 | Open the URL | the panel loads; the address bar no longer shows the token (redirect to `/`) | ☐ |
| D2 | Click each of the 8 screens in the nav: Сегодня, Проекты, Чат, История, Карта, Модели, Инструменты, Журнал | each loads, no red error, DevTools console has no errors | ☐ |
| D3 | Today screen: start a **Chat** run with "hello" | the answer streams in; the run appears in the list as finished | ☐ |
| D4 | Start a run whose text contains `лимит` | a limit stop is shown and a handoff card is offered/created | ☐ |
| D5 | Start a **Task in a branch** run | a branch `hub/<task>/<agent>` and a worktree folder `<project>-worktrees\...` are created | ☐ |
| D6 | **Map** screen after D3 to D5 | a tree with a root and children; edges have a reason label; a running node moves/pulses; a finished one settles | ☐ |
| D7 | Click a node | a side drawer shows model, effort, status, goal, context bar, cost, branch, **what it was taught** (mode rules, skills), and the log | ☐ |
| D8 | In the drawer of a finished run type a message and send | a new node appears, linked "your message"; the run continued | ☐ |
| D9 | Try the same on a node that cannot be messaged (a reviewer run, or a live run) | refused with a clear reason; nothing starts | ☐ |
| D10 | Journal: open the step journal preview for the task, then "write into the project" | shows the exact `specs/<task>/steps.md` text; writing asks for approval; creates the file; a backup exists; `hub undo` restores | ☐ |
| D11 | Mode picker on Today: try all five (Chat, Task, Interview, Autopilot, Review) | each starts or says exactly what is missing (Autopilot needs its skill and shows the exact command) | ☐ |
| D12 | Themes: switch **dark/light × green/orange** (4 combinations) on Today, Map, Models | text readable, no hard-coded colour clash, accent buttons have readable text, focus ring visible | ☐ |
| D13 | Width 375 px (DevTools device toolbar, iPhone SE/Galaxy S8) in all 4 themes, screens Today, Map, Chat | no horizontal scroll; buttons at least 44 px high; text at least 14 px | ☐ |
| D14 | Keyboard only: Tab through Today and Map; press Ctrl+K | focus order logical, nothing trapped; Ctrl+K opens the search dialog; Esc closes it | ☐ |
| D15 | DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce" on the Map | moving edges and pulses stop | ☐ |
| D16 | Stop the server (Ctrl+C), start it again | no "ghost running" run is shown; a run that was live is marked interrupted | ☐ |
| D17 | Window left open for 2 minutes with no activity, then click around | no "fetch failed", no logout | ☐ |

## Part E. Real agents (needs signed-in CLIs; spends a little limit)

Start the panel **without** `--demo` and with the scratch home: `node bin/hub.js ui --port 4777 --home D:\ah-test\home-real`. Use `D:\ah-test\proj1` (created in C2, it is a git repo; make one commit first: `git add -A && git commit -m init`). Keep prompts short. For E4 give the project a **local** remote (a push with no remote fails before the hub's guard is even reached): `git init --bare D:\ah-test\remote.git` then `git -C D:\ah-test\proj1 remote add origin D:\ah-test\remote.git`.

| ID | Step | Expected | Result |
|---|---|---|---|
| E1 | Claude, Chat: "Reply with the single word ok" | answer `ok`; tokens and cost shown on the run | ☐ |
| E2 | Claude, **Task in a branch**: "Create a file hello.txt with the word hi" | file exists only in the worktree branch, **not** in your main folder | ☐ |
| E3 | Resume the finished run from the Map with a follow-up ("now append a second line") | the same session continues (the file gets a second line) | ☐ |
| E4 | Ask the agent: "run `git push origin HEAD`" | the push is refused with "agent-hub: git push is disabled for agents"; `git -C D:\ah-test\remote.git log` shows no commits | ☐ |
| E5 | **Sub-agent:** "Use the Task tool to launch a sub-agent that lists the files in this folder, then tell me how many there are" | the Map shows a **sub-agent node** under the run with a "native sub-agent" edge; its context is shown as "not measured". **Copy the raw log lines about the sub-agent into the report (redacted already)**: the real event shape was never seen | ☐ |
| E6 | **Background process:** "Start `node -e \"setInterval(()=>{},1000)\"` in the background, wait 5 seconds, then stop it" | a "background shell" node appears while it runs and ends after the stop. Copy the related log lines into the report | ☐ |
| E7 | Codex, Chat and Task: same as E1 and E2 with `--agent codex` (panel agent selector) | works; if the model is rejected, copy the message | ☐ |
| E8 | Hand work over: during a Claude task press the handoff action (or ask `hub run … ` with a limit-like text), continue with Codex | a handoff card with git facts and a summary; Codex continues in the **same folder and branch** | ☐ |
| E9 | Context gauge: a run with a long prompt (paste about 20,000 words) | the gauge grows; no crash; if above the limit the run is stopped and continued fresh from a card (note whether the card is sensible) | ☐ |
| E10 | **Mode rules:** start one run in each mode and open its drawer → "taught" | the English rules text of that mode is listed; skills match the mode (Claude). For Codex the panel says skills are not restricted | ☐ |
| E11 | Secrets in a prompt: print a fake key with `'sk-ant-api03-' + ('A' * 40)` in PowerShell (it is built on the fly because the repository's own secret scan rightly rejects a literal one), paste it into a message | the stored prompt, the log and the journal show it **redacted**; it never appears in clear in the panel | ☐ |
| E12 | Circuit breaker: set a very low cap in the panel's limits (if offered), start two runs | the second is refused with the reason; nothing leaks | ☐ |
| E13 | Optional, costs more: **Cascade** with `verify` in `hub.json` (e.g. a failing test), or a **Review** on a small branch | a verify result per rung; the review gate ends in your approval, not before | ☐ |
| E14 | Optional: wall-clock behaviour: stop a live run with the Stop button | the run ends as `stopped` within a few seconds, the process is gone (Task Manager) | ☐ |

## Part F. Security of the local server

Start the demo server as in part D (token `TESTTOKEN`, port 4777). Run each command in a second PowerShell window.

| ID | Command | Expected | Result |
|---|---|---|---|
| F1 | `curl.exe -i http://127.0.0.1:4777/api/projects` | `401` unauthorized (no cookie) | ☐ |
| F2 | `curl.exe -i -H "Host: evil.example" http://127.0.0.1:4777/` | `403` bad host | ☐ |
| F3 | `curl.exe -i "http://127.0.0.1:4777/?t=WRONG"` | `403` bad token | ☐ |
| F4 | `curl.exe -i "http://127.0.0.1:4777/?t=TESTTOKEN"` | `302`; `Set-Cookie: hub_token=…; HttpOnly; SameSite=Strict; Path=/` | ☐ |
| F5 | `curl.exe -i -X POST -H "Cookie: hub_token=TESTTOKEN" -H "Origin: http://evil.example" -H "Content-Type: application/json" -d "{}" http://127.0.0.1:4777/api/projects` | `403` bad origin | ☐ |
| F6 | `curl.exe -i --path-as-is -H "Cookie: hub_token=TESTTOKEN" "http://127.0.0.1:4777/../../package.json"` | `403` or `404`; **never** the contents of `package.json` | ☐ |
| F7 | `netstat -ano \| findstr :4777` | listening on `127.0.0.1:4777` only (not `0.0.0.0`, not `[::]`) | ☐ |
| F8 | Create a 3 MB file `big.json` and `curl.exe -i -X POST -H "Cookie: hub_token=TESTTOKEN" -H "Origin: http://127.0.0.1:4777" -H "Content-Type: application/json" --data-binary "@big.json" http://127.0.0.1:4777/api/projects` | rejected with a 4xx status (not 200); the server keeps running | ☐ |
| F9 | `curl.exe -i -H "Cookie: hub_token=TESTTOKEN" http://127.0.0.1:4777/api/projects` | `200` with JSON | ☐ |
| F10 | From another machine on your network, open `http://<your-PC-ip>:4777/` | cannot connect | ☐ |
| F11 | In a normal browser tab open a page you control (any `http://localhost:8000` test page) that does `fetch('http://127.0.0.1:4777/api/projects')` | blocked (no CORS, no cookie); no data reaches the page | ☐ |
| F12 | Agent environment: ask a real agent (E1) to run `env` / `set` and print variables whose name contains `hub` | no hub token, cookie or secret is visible | ☐ |
| F13 | Foreign storage is read-only: note the newest modification time under `~/.claude` and `~/.codex` (no agent session open), run `node bin/hub.js sync`, check again | unchanged | ☐ |
| F14 | A project whose `hub.json` has a hostile `verify` (e.g. `["node","-e","require('fs').writeFileSync('PWNED','x')"]`) | the hub shows the exact command and **does not run it** before your approval; after "no" nothing is created | ☐ |

## Part G. Documents match reality

| ID | Step | Expected | Result |
|---|---|---|---|
| G1 | Open `docs/STATUS.md`; for 5 claims marked "observed", repeat the check | each holds | ☐ |
| G2 | `docs/PIPELINES-REVIEW.md`: pick 3 "not verified" items | they are still honestly unverified, or now verified by part E (say which) | ☐ |
| G3 | README commands: run every command block that is not marked "optional" | each works as written | ☐ |
| G4 | ADR index (`docs/adr/README.md`) against the files in `docs/adr/` | every ADR has a file and a row | ☐ |

## Part H. The public repository itself

| ID | Step | Expected | Result |
|---|---|---|---|
| H1 | `git ls-files` in a fresh clone: look for `_local`, `.hub/handoffs`, `graphify-out/20…`, `auth`, `.env`, `secrets` | none of them is tracked (a tracked `src/adapters/auth*.ts` is code, not a credential) | ☐ |
| H2 | Secrets in **history**: `node scripts/security.mjs --docker` (gitleaks) or `git log -p \| Select-String -Pattern "sk-ant-\|ghp_\|AKIA\|BEGIN (RSA\|OPENSSH) PRIVATE"` | nothing real found | ☐ |
| H3 | Repository page: description, topics, license badge `MIT`, README as the front page | present; tell me what is missing | ☐ |
| H4 | Files `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` exist and show in the "Community" tab | present | ☐ |
| H5 | Settings → Code security: switch on **private vulnerability reporting**, **Dependabot alerts**, **secret scanning + push protection** | on (these are your actions; I cannot do them) | ☐ |
| H6 | Actions → **ci** → Run workflow (branch `main`) | 13 jobs (`checks` + 12 folders) all green. **This has never been run**: for each red job paste the "Summary" table or the last 25 log lines | ☐ |
| H7 | Settings → Branches: protect `main` (require the ci checks before merge) | on, once H6 is green | ☐ |
| H8 | Commit author email in `git log -3 --format=%ae` | you know it is public; decide whether to keep it (hiding it for old commits means rewriting history, which I will not do without your explicit word) | ☐ |
| H9 | Issues enabled; one test issue opens and can be closed | works | ☐ |

---

## Part I. Report

Copy this block into a message or issue and fill it in.

```
Environment: OS ____ · Node ____ · CPU/RAM ____ · browser ____ · commit ____
Claude CLI version ____ (signed in: yes/no) · Codex CLI version ____ (signed in: yes/no) · Docker: yes/no

Totals from test-report.md (B1): tests ____ pass ____ fail ____   (author's baseline: see below)

Results (paste only rows that are not PASS; "all other rows PASS" is fine):
ID   | Result | What you saw (exact message / screenshot name)
-----|--------|-----------------------------------------------
...

Raw event lines for E5 and E6 (sub-agent, background shell), redacted: attached / not run

Anything surprising, slow, confusing, or missing from the README:
...
```

**Author's baseline** (observed on the author's machine, Windows 11, Node 24, before this plan was written): filled in from the last full run of `node scripts/test-all.mjs` below.

Run of 2026-10-29 on Windows 11, Node v24.14.0, 8 CPUs, 32 GB, one folder after the other (about 6 minutes, observed):

| Folder | Tests | | Folder | Tests |
|---|---|---|---|---|
| adapters | 44 | | lib | 21 |
| bench | 8 | | review | 248 |
| cli | 6 | | run | 186 |
| core | 92 | | server | 77 |
| diagram | 4 | | stages | 2 |
| econ | 82 | | history | 16 |

**Total 786 pass, 0 fail**; `tsc` clean; `scripts/security.mjs` 17 / 17; diagrams up to date. Your totals should be the same on the same commit; a difference means a test is environment-dependent, which is worth reporting. The first attempt of this run found two defects of the *test tooling* (not of the hub): a scratch path given with forward slashes failed one path-comparison test in `review`, and the plan itself contained a fake key that the repository's secret scan rejected. Both are fixed and pinned by `src/lib/test-all.test.ts`.

## What a result means

- `FAIL` in parts B, F, H1, H2: a real defect, blocks calling the repository ready.
- `FAIL` in part E: expected to happen at first; these parts exercise the real CLIs, which no automated test could (see `docs/STATUS.md`, "not verified"). Every such finding is valuable: send the exact message.
- `FAIL` in D12 to D15: UI rules from `AGENTS.md` (tokens, four themes, 375 px, 44 px targets, reduced motion).
- `SKIP` is honest; `BLOCKED` means a step before it failed.
