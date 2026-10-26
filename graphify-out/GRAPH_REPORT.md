# Graph Report - agent-hub  (2026-10-26)

## Corpus Check
- 160 files · ~115,947 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1095 nodes · 2833 edges · 72 communities (56 shown, 16 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 86 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ebc8a9e5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- h
- workmodes.ts
- Agent Hub (local-first hub for coding agents)
- prompt.md (pinned reconstruction prompt S1)
- Tooling for building the project (TOOLING.md)
- store.ts
- loading.ts
- main.ts
- api.ts
- index.ts
- security.mjs
- Agent Hub — Project Specification & Delivery Plan
- install-remote.ts
- redact
- build-tokens.mjs
- hooks.ts
- scout-remote.ts
- hub.js
- fake-agent.mjs
- CLAUDE.md (pointer to AGENTS.md)
- Agent Hub — архитектура
- 2. Схема базы
- server.test.ts
- mcp-test.ts
- probe.ts
- core.test.ts
- install.test.ts
- hooks-adopt.test.ts
- econ.ts
- RunManager
- core/types.ts
- AgentId
- install-remote.test.ts
- loading.test.ts
- registry.ts
- Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать
- run.test.ts
- AGENTS.md
- server.ts
- runner.ts
- Optimization (OPTIMIZATION.md)
- Agent Hub v0.2 Implementation Plan
- Models and limits (MODELS-AND-LIMITS.md)
- hooks-run.ts
- Phase PR — Mandatory thorough review (a gate, not an option)
- automation.md
- design-study.md
- mobile-app.md
- web-saas.md
- Security and vulnerability checks (SECURITY.md)
- Deviations from the plan (ADR-010 to ADR-015)
- Phase 3 — Model and effort routing toward the ideal
- Workflow (one task, one worktree, test first)
- Phase 7 — Observability and forecasting
- Phase 2 — Chat and history like the real CLIs
- Phase 4 — Token economy
- Phase 5 — Fastest entry: starter kit
- Phase 1 — Modes that really work
- greet.js
- Account
- unique.test.js
- sum.js
- chunk.js
- slug.js
- legacy.js
- cache.js

## God Nodes (most connected - your core abstractions)
1. `h()` - 76 edges
2. `main()` - 40 edges
3. `btn()` - 35 edges
4. `chip()` - 32 edges
5. `AgentId` - 31 edges
6. `icon()` - 31 edges
7. `RunManager` - 25 edges
8. `pageHead()` - 25 edges
9. `toast()` - 23 edges
10. `readText()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `Agent Hub (local-first hub for coding agents)` --semantically_similar_to--> `Repository map`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `Models and effort policy` --references--> `Security and vulnerability checks (SECURITY.md)`  [INFERRED]
  AGENTS.md → docs/SECURITY.md
- `Screen intent: blocked-on-user first` --semantically_similar_to--> `Attention hierarchy: decision card primary`  [INFERRED] [semantically similar]
  design/research/STUDY.md → design/research/ux-plan-today.json
- `Safety model (localhost, read-only stores, plan-confirm writes)` --semantically_similar_to--> `Hard rules (credentials, read-only stores, no push)`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `auditLoading()` --indirect_call--> `where()`  [INFERRED]
  src/core/loading.ts → web/js/views/library.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Zero-dependency stack decisions** — docs_adr_010_single_package_zero_deps, docs_adr_011_json_instead_of_yaml, docs_adr_012_panel_without_react, docs_adr_013_typescript_type_stripping [EXTRACTED 1.00]
- **Safe handoff and run chain** — readme_handoff, adr_014_hub_commits_only_on_own_branches, docs_adr_015_prompt_through_stdin, readme_push_guard [INFERRED 0.85]
- **Unverified claims and limits cluster** — docs_status_codex_success_path_unverified, docs_status_claude_rate_limit_event_unseen, docs_status_docker_scanners_not_run, docs_status_untested_platforms, docs_status_terms_of_use_unchecked [INFERRED 0.85]
- **Prototype S1 render pipeline** — design_prototypes_app_render, design_prototypes_app_today, design_prototypes_app_task, design_prototypes_app_toolkit, design_prototypes_app_rail, design_prototypes_app_tablens, design_prototypes_app_dock [EXTRACTED 0.95]
- **Study S1 design loop (prompt, build, review, revise)** — design_research_prompt, design_research_ux_plan_today, design_research_study, design_prototypes_app, design_research_review, design_research_revisions [INFERRED 0.85]
- **Handoff card dialog flow** — design_prototypes_app_click_handler, design_prototypes_app_opensheet, design_prototypes_app_cardsheet, design_research_ux_plan_today_controls [INFERRED 0.75]
- **Token and cost reduction measures validated by A/B** — docs_optimization_stable_prefix, docs_optimization_two_level_skills, docs_tooling_ponytail, docs_tooling_graphify, docs_optimization_golden_task_set, docs_tooling_token_saving_measures [INFERRED 0.85]
- **Four-theme design system pipeline** — design_design_system_tokens_css, design_design_system_shadcn_bridge, design_design_system_contrast_measurements, design_preview [INFERRED 0.85]

## Communities (72 total, 16 thin omitted)

### Community 0 - "h"
Cohesion: 0.08
Nodes (117): api, call(), prefs, qs(), stream(), app, main, NAV (+109 more)

### Community 1 - "workmodes.ts"
Cohesion: 0.22
Nodes (11): AP_DEPTHS, AP_MODES, applyWorkMode(), CLASSES, loadWorkModes(), ORDER, parseWorkMode(), PERMS (+3 more)

### Community 2 - "Agent Hub (local-first hub for coding agents)"
Cohesion: 0.09
Nodes (31): Mission: local-first hub unifying agents, Repository map, ADR-015: prompt goes through stdin, never arguments, Claude rate_limit_event shape never seen, Real Codex rate_limits snapshot (94 percent of weekly window), Codex success path unverified, Docker scanners not run (gitleaks, semgrep, trivy), Real history import: 18 s first run, 0.0 s re-sync (+23 more)

### Community 3 - "prompt.md (pinned reconstruction prompt S1)"
Cohesion: 0.07
Nodes (50): tokens.css / tokens.json (generated), preview.html (live board of four themes), cardSheet (handoff card dialog), app click/change event handlers, compat / compatCell, decision (T016 decision card), diffSheet (changes-to-write dialog), dock (mobile bottom glass dock) (+42 more)

### Community 4 - "Tooling for building the project (TOOLING.md)"
Cohesion: 0.14
Nodes (21): Agent Hub Design System v0.1, Accent edge (light themes), Accent fill vs accent text rule, First component set (limit meter, handoff card, stage stepper, approval diff sheet), Measured contrast table, Material: opaque work surfaces, glass only for navigation, shadcn/ui variable bridge, Typography (Golos Text, JetBrains Mono) (+13 more)

### Community 5 - "store.ts"
Cohesion: 0.07
Nodes (52): db, t, Block, clip(), isNoise(), Line, syncClaude(), SyncStats (+44 more)

### Community 6 - "loading.ts"
Cohesion: 0.16
Nodes (18): auditLoading(), CLAUDE_FILE, ClaudeLocal, CodexBlock, compileProfile(), Desired, LoadingAudit, mcpNamesClaude() (+10 more)

### Community 7 - "main.ts"
Cohesion: 0.24
Nodes (29): Args, BOOL, cmdBench(), cmdGet(), cmdHooks(), cmdInit(), cmdInstall(), cmdMcp() (+21 more)

### Community 8 - "api.ts"
Cohesion: 0.09
Nodes (23): AuthInfo, authStatus(), cache, forgetAuth(), parseAuth(), Runner, AgentInfo, codexFromAppData() (+15 more)

### Community 9 - "index.ts"
Cohesion: 0.14
Nodes (25): ARCH, archDoc(), box(), build(), check(), dataDoc(), Doc, Format (+17 more)

### Community 10 - "security.mjs"
Cohesion: 0.12
Nodes (17): all, code, dir, failed, files(), hits, inline, inner (+9 more)

### Community 11 - "Agent Hub — Project Specification & Delivery Plan"
Cohesion: 0.05
Nodes (37): 0. Document map, 10. Definition of Done (every task), 11. Risks and open questions, 12. Decisions so far (by the author), 1.1 Problem, 1.2 Product, 1.3 Users, 1.4 Goals / non-goals / anti-goals (+29 more)

### Community 12 - "install-remote.ts"
Cohesion: 0.27
Nodes (10): ALLOWED(), defaultTextFetcher(), planLibraryInstall(), Preview, previewComponent(), RawItem, relOk(), slug() (+2 more)

### Community 13 - "redact"
Cohesion: 0.12
Nodes (26): fake, run(), withFake(), Block, brief(), claudeAdapter, codexAdapter, Item (+18 more)

### Community 14 - "build-tokens.mjs"
Cohesion: 0.29
Nodes (6): bridge, css, root, sel, shared, themes

### Community 15 - "hooks.ts"
Cohesion: 0.47
Nodes (5): classifyHooks(), ClaudeHooks, CODEX_KNOWN_EVENTS, HookReport, Compat

### Community 16 - "scout-remote.ts"
Cohesion: 0.15
Nodes (15): Candidate, AitmplItem, defaultFetcher(), fetchAitmpl(), Fetcher, GhRunner, risk(), searchGithub() (+7 more)

### Community 17 - "hub.js"
Cohesion: 0.50
Nodes (3): dist, hi, root

### Community 22 - "Agent Hub — архитектура"
Cohesion: 0.08
Nodes (25): 10. Технологический выбор (кратко, решения), 11. Порядок сборки, 12. Что не проверено и риски, 1. Зачем это нужно, 2. Цели, не-цели, анти-цели, 3. Принципы, 4.1. Ядро (`packages/core`), 4.2. Адаптеры (`packages/adapter-*`) (+17 more)

### Community 23 - "2. Схема базы"
Cohesion: 0.11
Nodes (18): 1.1. `hub.yaml` — проект, 1.2. `toolkit.yaml` — выбранные инструменты проекта (этап 3), 1.3. `hub.lock` — воспроизводимая установка, 1.4. Запись реестра `registry/entries/<kind>/<name>.yaml`, 1.5. Этап `stages/<name>.yaml`, 1.6. Карточка передачи `.hub/handoffs/<id>.md`, 1. Файловые форматы, 2.1. Агенты и аккаунты (+10 more)

### Community 24 - "server.test.ts"
Cohesion: 0.14
Nodes (8): db, fake, fakeAgent, fakeExe, runs, scenario, sk, stub

### Community 25 - "mcp-test.ts"
Cohesion: 0.36
Nodes (6): ProbeResult, probeStdio(), Server, dir, fakeServer, testProject()

### Community 26 - "probe.ts"
Cohesion: 0.21
Nodes (12): Capability, classify(), Ev, IS_TOOL, loadMatrix(), ModeMatrix, probeModes(), repo() (+4 more)

### Community 31 - "econ.ts"
Cohesion: 0.06
Nodes (55): advise(), Choice, EXPLORABLE, full(), GPT_EFFORT, left(), LimitState, MODEL_GUIDE (+47 more)

### Community 32 - "RunManager"
Cohesion: 0.17
Nodes (8): BenchOpts, Db, runHooks(), waitEnd(), projectTypeOf(), RunManager, waitForRun(), Ctx

### Community 33 - "core/types.ts"
Cohesion: 0.12
Nodes (34): compileAll(), compileMcpClaude(), compileMcpCodex(), compileRules(), compileSkill(), McpJson, mcpName(), projectType() (+26 more)

### Community 34 - "AgentId"
Cohesion: 0.13
Nodes (21): BenchRow, CLASSES, freshRepo(), GoldenTask, gradeRepo(), loadTasks(), parsePicks(), Pick (+13 more)

### Community 35 - "install-remote.test.ts"
Cohesion: 0.67
Nodes (3): catalog(), fake, fetcher()

### Community 36 - "loading.test.ts"
Cohesion: 0.67
Nodes (3): fake, mk(), skill()

### Community 38 - "registry.ts"
Cohesion: 0.15
Nodes (22): cmdConfig(), home(), listPlugins(), PluginInfo, skillCost(), suggest(), addSkillRoot(), loadCatalog() (+14 more)

### Community 39 - "Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать"
Cohesion: 0.11
Nodes (18): 1. Адаптировано ли использование токенов, 1. Главный вывод про токены, 2. Выбор модели: не правило, а ближайшая точка к идеалу, 2. Как устроена «инструменты только под проект», 3. Как это выглядит в панели, 3. Сбор данных пользователей с согласия, 4. Как запустить, 5. Аудит качества: что нашёл и исправил (+10 more)

### Community 40 - "run.test.ts"
Cohesion: 0.17
Nodes (22): branchName(), checkpoint(), checkSparse(), createWorktree(), facts, git(), GitResult, isGitRepo() (+14 more)

### Community 41 - "AGENTS.md"
Cohesion: 0.20
Nodes (9): AGENTS.md, Definition of done, Hard rules, How to work, by kind of task, Models and effort, Save tokens, Skills by situation (use if installed), Start here (+1 more)

### Community 42 - "server.ts"
Cohesion: 0.31
Nodes (9): safeJoin(), bad(), handle(), cookieOf(), eqToken(), MIME, Started, startServer() (+1 more)

### Community 43 - "runner.ts"
Cohesion: 0.26
Nodes (8): Permission, HandoffInput, leanArgs(), RunManagerOpts, RunRow, StartReq, StoredEvent, Summary

### Community 44 - "Optimization (OPTIMIZATION.md)"
Cohesion: 0.19
Nodes (13): Eleven practices to keep spend low, Optimization (OPTIMIZATION.md), Golden task set eval/golden, harness2 mechanisms adopted (probes, lessons, golden eval), Hypotheses to test first, Lessons with evidence (.hub/lessons), Three memory types (semantic, episodic, procedural), Two-level skills (profile of 15 + hub-skill-index) (+5 more)

### Community 45 - "Agent Hub v0.2 Implementation Plan"
Cohesion: 0.15
Nodes (12): Agent Hub v0.2 Implementation Plan, Global Constraints, Out of scope for v0.2, Phase 0 — Measure before changing, Phase 6 — Wrap-up, Research basis → decisions, Review Focus, Skills by step (load only the one the step names) (+4 more)

### Community 46 - "Models and limits (MODELS-AND-LIMITS.md)"
Cohesion: 0.24
Nodes (11): Models and limits (MODELS-AND-LIMITS.md), Two-week calibration plan, Claude API pricing table, Codex as fallback when Claude Pro limit is hit, Codex log findings (97.9 percent cache, 57 percent subagent tokens), Escalation ladder and triggers, Weekly limit percent cannot be derived by formula, Model allocation (Opus 27 sessions, Sonnet 69) (+3 more)

### Community 47 - "hooks-run.ts"
Cohesion: 0.38
Nodes (10): approvalFile(), approvals(), approveRunnerHooks(), argvList(), digest(), empty(), HookResult, readRunnerHooks() (+2 more)

### Community 48 - "Phase PR — Mandatory thorough review (a gate, not an option)"
Cohesion: 0.20
Nodes (10): Phase PR — Mandatory thorough review (a gate, not an option), Phase PR review, Task PR.1: Review data model and ADR, Task PR.2: Structured reviewers (hunt + verify), Task PR.3: Filter, tag, pre-existing, Task PR.4: Checks first, security pass, risk tier, Task PR.5: Gate orchestration and convergence, Task PR.6: REVIEW.md and rule drift (+2 more)

### Community 54 - "Security and vulnerability checks (SECURITY.md)"
Cohesion: 0.36
Nodes (9): ADR-014: hub commits only on hub/* branches, Hard rules (credentials, read-only stores, no push), Security and vulnerability checks (SECURITY.md), Third-party component risk assessment, Security merge gates, Security scanners (gitleaks, semgrep, osv-scanner, trivy via Docker), Threat model T1 to T10, Push guard (blocking hook via environment) (+1 more)

### Community 55 - "Deviations from the plan (ADR-010 to ADR-015)"
Cohesion: 0.39
Nodes (9): Code conventions (single package, erasable TS, JSON, Windows first), UI rules (tokens, four themes, sizes), ADR-010: one package, zero runtime dependencies, ADR-011: JSON file formats instead of YAML, ADR-012: panel is plain ES modules, no React, no bundler, ADR-013: TypeScript via Node type stripping, tsc build for publishing, Deviations from the plan (ADR-010 to ADR-015), Panel verified in Chrome (4 themes, desktop and 390 px) (+1 more)

### Community 56 - "Phase 3 — Model and effort routing toward the ideal"
Cohesion: 0.22
Nodes (9): Phase 3 — Model and effort routing toward the ideal, Phase 3 review, Task 3.1: (model, effort) pairs as options, Task 3.2: Vendor strengths as tagged priors, Task 3.3: Verify-and-escalate cascade (the user's working principle as a product feature), Task 3.4: Quality from verification, not guesses, Task 3.5: Strategy comparison on the user's own data, Task 3.6: Task type detection (+1 more)

### Community 57 - "Workflow (one task, one worktree, test first)"
Cohesion: 0.25
Nodes (8): Definition of done, Graph (graphify) rules, Models and effort policy, Read order for a task (graph first), Skills by situation table, Token discipline, Workflow (one task, one worktree, test first), Development commands (test, typecheck, security, build, tokens)

### Community 58 - "Phase 7 — Observability and forecasting"
Cohesion: 0.29
Nodes (7): Phase 7 — Observability and forecasting, Phase 7 review, Task 7.1: Detailed run trace, Task 7.2: Live context gauge, Task 7.3: Project forecast, Task 7.4: Use the leftover limit before reset (opt-in), Task 7.5: Guardrails (circuit breaker)

### Community 59 - "Phase 2 — Chat and history like the real CLIs"
Cohesion: 0.33
Nodes (6): Phase 2 — Chat and history like the real CLIs, Phase 2 review, Task 2.1: Event model v2, Task 2.2: CLI-like transcript renderer, Task 2.3: History rendered from the source files, continuable, Task 2.4: Keep one Claude process per chat (spike, then decide)

### Community 60 - "Phase 4 — Token economy"
Cohesion: 0.33
Nodes (6): Phase 4 review, Phase 4 — Token economy, Task 4.1: Context rules that save tokens (+ the Autopilot rules), Task 4.2: Per-task tool sets (skills, plugins, MCP), Task 4.3: Fresh context at the right size, Task 4.4: Graph as a first-class project tool

### Community 61 - "Phase 5 — Fastest entry: starter kit"
Cohesion: 0.33
Nodes (6): Phase 5 — Fastest entry: starter kit, Phase 5 review, Task 5.1: First-run wizard, Task 5.2: Project templates (architectures), Task 5.3: Shipped work modes wired to installed skills, Task 5.4: One-command start on Windows

### Community 62 - "Phase 1 — Modes that really work"
Cohesion: 0.40
Nodes (5): Phase 1 — Modes that really work, Phase 1 review, Task 1.1: Permission presets, applied on start **and** resume, Task 1.2: Live mode probe (`hub doctor --modes`), Task 1.3: Work modes (presets) — Chat, Task, Interview, Autopilot, Review

### Community 63 - "greet.js"
Cohesion: 0.60
Nodes (3): greet(), getUsr(), users

## Knowledge Gaps
- **331 isolated node(s):** `hi`, `root`, `dist`, `root`, `themes` (+326 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `advise()` connect `econ.ts` to `api.ts`, `h`, `main.ts`?**
  _High betweenness centrality (0.107) - this node is a cross-community bridge._
- **Why does `tasks()` connect `h` to `econ.ts`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **What connects `hi`, `root`, `dist` to the rest of the system?**
  _331 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `h` be split into smaller, more focused modules?**
  _Cohesion score 0.07900347884636966 - nodes in this community are weakly interconnected._
- **Should `Agent Hub (local-first hub for coding agents)` be split into smaller, more focused modules?**
  _Cohesion score 0.09032258064516129 - nodes in this community are weakly interconnected._
- **Should `prompt.md (pinned reconstruction prompt S1)` be split into smaller, more focused modules?**
  _Cohesion score 0.07215686274509804 - nodes in this community are weakly interconnected._
- **Should `Tooling for building the project (TOOLING.md)` be split into smaller, more focused modules?**
  _Cohesion score 0.13768115942028986 - nodes in this community are weakly interconnected._