# Agent Hub

One local hub for coding agents. Shared skills, rules and MCP for **Claude Code** and **Codex**; a chat and task runner for any of them; a **handoff card** so work continues on another agent when one hits its limit; unified history, cost advice and a lifecycle for every project.

> Status: **v0.1.0 — first working version, local only, not published.** See [docs/STATUS.md](docs/STATUS.md) for what is done, what is partial and what is not verified.

## What it does

| Area | What you get |
|---|---|
| **Library** | One catalog of skills / MCP. `hub init` shows a plan (every file, as a diff) and writes nothing until you confirm; backups + `hub undo`. Same skills and `AGENTS.md` rules for Claude and Codex; MCP written to `.mcp.json` and `.codex/config.toml`. |
| **Chat & tasks** | Chat with any agent inside the panel (like Claude Code / Codex), or run a task in its own git worktree. Live stream, tool calls, full event log. |
| **Handoff** | Agent stops on a limit → hub commits a checkpoint on its own `hub/<task>/<agent>` branch, writes a card (facts from git + logs, not from model memory) → one click continues on the other agent in the same folder. |
| **History** | Claude (`~/.claude`) and Codex (`~/.codex`) sessions imported read-only into one searchable index (8.5 GB of Codex logs in ~18 s, instant re-sync). Secrets are redacted before indexing. |
| **Models & limits** | Weekly limit from Codex logs, manual entry for Claude, measured token profiles from your own history, API-equivalent cost (Claude prices verified, unknown prices stay *unknown*), advice with the rule that produced it. |
| **Lifecycle** | 8 stages with gates (context → clarify → toolkit → architecture → rules → plan → execute → retro). A stage closes only when its output files exist and you approve. |
| **Panel** | Projects, chat, tasks, history, library, models, logs, settings. Dark/light × green/orange. Localhost only. |

## Requirements

- Node.js **24+** (uses built-in `node:sqlite` and TypeScript type stripping), Git.
- Optional: `claude` and/or `codex` CLIs. `claude` must be logged in **in a terminal** (Claude Desktop logs in separately): run `claude`, then `/login`.
- Windows 11 is the primary platform (junction links, `\\?\` paths handled). macOS/Linux are untested.

## Quick start

```bash
npm install                       # dev tools only (TypeScript); zero runtime dependencies
node bin/hub.js doctor            # what is installed
node bin/hub.js ui                # panel on 127.0.0.1 (prints a one-time link)
node bin/hub.js ui --demo         # same, with scripted fake agents: spends no limits
```

Handy commands:

```bash
hub init [path] --type web-saas   # dry run; add --yes to apply
hub new web-saas ./my-site         # new project from a template (new or empty folder only); add --yes to apply
hub chat [path] --agent auto      # terminal chat
hub run "prompt" [path] --agent codex --task T016 --worktree
hub install [path]                # after git clone: re-create links/MCP from hub.lock.json
hub tools [path]                  # what loads into every turn (skills, plugins, MCP) and what it costs
hub profile --off a,b --plugin-off id   # trim that for this project only
hub get aitmpl/skills/<cat>/<name>      # fetch into the hub library after a full preview (0 tokens until linked)
hub scout --source aitmpl --brief "browser tests"   # proposals from outside catalogs (never installs)
hub hooks hooks.json --adopt      # run a Claude plugin's simple hooks from the hub, for any agent
hub config add-skill-root <dir>   # extra folder with your own skills
hub mcp test [path]               # MCP handshake (starts servers only with --yes)
hub open claude [path]            # native Claude/Codex UI in the project folder
hub sync && hub history "handoff" # import + search all sessions
hub estimate --class implement    # cost / limit range and the model advice
hub diagram routing --format mermaid
hub security                      # dependency, secret and code-pattern checks
```

## Safety model

- Server binds `127.0.0.1` only; one-time token in an `HttpOnly; SameSite=Strict` cookie; `Host` and `Origin` checks; JSON-only writes; CSP.
- Foreign stores (`~/.claude`, `~/.codex`) are read-only; credential files are never opened.
- Every write into a project is a plan you confirm, with backup and undo. Agents cannot `git push` (a blocking hook is injected through environment, nothing is written to your git config).
- Registry/third-party text is data, never instructions. The hub never commits in your own working tree; it commits only on `hub/*` branches it created.

Details: [docs/SECURITY.md](docs/SECURITY.md).

## Layout

```
bin/hub.js        entry (dist/ if built, else TypeScript source)
src/              core · history · adapters · run · econ · stages · diagram · server · cli · lib
web/              the panel (ES modules, no build step, local fonts)
design/           themes.json → tokens.css (4 themes), DESIGN-SYSTEM.md, build-tokens.mjs
registry/ packs/ stages/   catalog entries, project-type presets, lifecycle stages
docs/             PLAN, ARCHITECTURE, DATA-MODEL, SECURITY, STATUS, ADRs, generated diagrams
```

## Development

```bash
npm test            # 95 tests (node:test), including real recorded CLI error shapes
npm run typecheck   # tsc --noEmit, strict
npm run security    # 14 checks; add --docker for gitleaks/semgrep when Docker is running
npm run build       # compile to dist/ for publishing
npm run tokens      # regenerate design tokens from design/themes.json
```

Rules for agents working in this repo: [AGENTS.md](AGENTS.md).

## License

MIT. Fonts (Golos Text, JetBrains Mono) are SIL OFL 1.1, see `web/fonts/LICENSE.txt`.
