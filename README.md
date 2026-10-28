# Agent Hub

One local hub for coding agents. Shared skills, rules and MCP for **Claude Code** and **Codex**; a chat and task runner for any of them; a **handoff card** so work continues on another agent when one hits its limit; unified history, cost advice and a lifecycle for every project.

> Status: **v0.2 (branch `v0.2/p-pr-review`) — working locally; the real Claude and Codex CLIs have not driven the new v0.2 parts end to end.** [docs/STATUS.md](docs/STATUS.md) says per requirement what was observed (ran or saw it), what is only inferred and what is not verified. Decisions: [docs/adr/README.md](docs/adr/README.md).

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
| **Review gate (v0.2)** | Every agent branch goes through checks you approved (digest-pinned) and independent reviewers; only a human approval counts. `hub review-eval` measures reviewer recall and noise. ADR-019. |
| **Routing & cascade (v0.2)** | Model and effort chosen by task type with sourced priors; optional verify-and-escalate cascade; editable price table. ADR-017. |
| **Token economy (v0.2)** | Lean per-mode tool sets, context rules, fresh session from the handoff card past 250K tokens, project graph. ADR-018, 020, 021. |
| **Observability (v0.2)** | Per-call run trace, live context gauge, project forecast, opt-in use of the leftover limit before reset, circuit breaker for runaway runs (on by default). ADR-024…026. |
| **Starter kit & templates (v0.2)** | First-run wizard; `hub new <type> <folder>`. Everything is shown as a plan first. ADR-022, 023. |

## Быстрый старт (Windows)

Пакет **не опубликован** (`private: true`): запуск идёт из папки проекта. Сначала проверка, она только читает и ничего не меняет:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1   # Node 24+, Git, найденные claude/codex; печатает следующие команды
npm install                                         # только TypeScript для разработки; зависимостей в рантайме нет
node bin/hub.js ui                                  # панель на 127.0.0.1 (одноразовая ссылка); при первом запуске откроется мастер
```

- `-ExecutionPolicy Bypass` действует только на этот один запуск PowerShell и ничего не меняет в настройках компьютера. `scripts/install.ps1` ничего не скачивает и не ставит, не пишет файлов, не трогает политику выполнения, PATH и реестр; он не обязателен: достаточно `node bin/hub.js doctor`.
- Мастер первого запуска предлагает короткий набор навыков (ADR-022) и шаблоны проектов (`hub new <тип> <папка>`, ADR-023). Всё показывается планом и ставится только после вашего подтверждения.
- Режимы работы: «Интервью» подключает навык `grill-me`, если он лежит в ваших навыках Claude или подключён из библиотеки hub (папка самого проекта не считается; иначе идёт без него и пишет об этом; с `grill-me` загружаются все навыки, это стоит токенов); «Автопилот» требует навык `autopilot` и без него отказывает с точной командой; «Ревью» читает только; если агент не назван, ревьюит Codex (когда вы вошли и лимит не исчерпан), иначе Opus, а при известном авторе правки берётся другой вендор.

**Не проверено:** macOS и Linux; Safari; вход в реальные аккаунты Claude и Codex и реальный расход лимитов; установка из опубликованного пакета (его нет); `scripts/install.ps1` проверен в Windows PowerShell 5.1 на одном компьютере, PowerShell 7 и Windows 10 не проверялись; сборка `dist/` и её запуск вне исходной папки целиком не проверялись.

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
hub bench --dry                   # golden tasks: solved count and cost per solved task (lists the tasks only with --dry)
hub review-eval --dry             # reviewer quality cases: recall, noise (real reviewers need a signed-in CLI)
hub doctor --modes                # what each permission mode allows (short real runs)
hub stage . approve 1             # lifecycle stages and gates
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
npm test            # node:test, all folders in one run (over 10 minutes on a loaded machine: run per folder, e.g. node --test "src/server/**/*.test.ts")
npm run typecheck   # tsc --noEmit, strict
npm run security    # dependency, secret, code-pattern and package-content checks; add --docker for gitleaks/semgrep when Docker is running
npm run build       # compile to dist/ (not used for the clone-and-run start above)
npm run tokens      # regenerate design tokens from design/themes.json
```

Rules for agents working in this repo: [AGENTS.md](AGENTS.md).

## License

MIT. Fonts (Golos Text, JetBrains Mono) are SIL OFL 1.1, see `web/fonts/LICENSE.txt`.
