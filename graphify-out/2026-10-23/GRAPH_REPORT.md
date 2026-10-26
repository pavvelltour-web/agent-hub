# Graph Report - agent-hub  (2026-10-23)

## Corpus Check
- 120 files · ~92,567 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 890 nodes · 2412 edges · 53 communities (44 shown, 9 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 81 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- h
- run.test.ts
- Agent Hub (local-first hub for coding agents)
- prompt.md (pinned reconstruction prompt S1)
- Optimization (OPTIMIZATION.md)
- store.ts
- loading.ts
- main.ts
- api.ts
- index.ts
- security.mjs
- Agent Hub — Project Specification & Delivery Plan
- install-remote.ts
- runner.ts
- build-tokens.mjs
- effective
- scout-remote.ts
- hub.js
- fake-agent.mjs
- CLAUDE.md (pointer to AGENTS.md)
- Agent Hub — архитектура
- 1. Файловые форматы
- server.test.ts
- plan.ts
- locate.ts
- core.test.ts
- install.test.ts
- hooks-adopt.test.ts
- profile.ts
- econ.ts
- RunManager
- core/types.ts
- hooks-run.ts
- install-remote.test.ts
- loading.test.ts
- AgentId
- registry.ts
- Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать
- Models and limits (MODELS-AND-LIMITS.md)
- AGENTS.md
- server.ts
- Agent Hub Design System v0.1
- Tooling for building the project (TOOLING.md)
- engine.ts
- 2. Схема базы
- PLAN.md
- Model allocation (Opus 27 sessions, Sonnet 69)
- automation.md
- design-study.md
- mobile-app.md
- web-saas.md

## God Nodes (most connected - your core abstractions)
1. `h()` - 75 edges
2. `main()` - 38 edges
3. `btn()` - 35 edges
4. `icon()` - 31 edges
5. `chip()` - 29 edges
6. `pageHead()` - 25 edges
7. `AgentId` - 24 edges
8. `toast()` - 23 edges
9. `readText()` - 22 edges
10. `empty()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Agent Hub (local-first hub for coding agents)` --semantically_similar_to--> `Repository map`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `Screen intent: blocked-on-user first` --semantically_similar_to--> `Attention hierarchy: decision card primary`  [INFERRED] [semantically similar]
  design/research/STUDY.md → design/research/ux-plan-today.json
- `Safety model (localhost, read-only stores, plan-confirm writes)` --semantically_similar_to--> `Hard rules (credentials, read-only stores, no push)`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `auditLoading()` --indirect_call--> `where()`  [INFERRED]
  src/core/loading.ts → web/js/views/library.js
- `tasks()` --indirect_call--> `advise()`  [INFERRED]
  web/js/views/project.js → src/econ/advisor.ts

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

## Communities (53 total, 9 thin omitted)

### Community 0 - "h"
Cohesion: 0.08
Nodes (111): api, call(), prefs, qs(), stream(), app, main, NAV (+103 more)

### Community 1 - "run.test.ts"
Cohesion: 0.22
Nodes (17): branchName(), checkpoint(), checkSparse(), createWorktree(), facts, git(), GitResult, isGitRepo() (+9 more)

### Community 2 - "Agent Hub (local-first hub for coding agents)"
Cohesion: 0.06
Nodes (54): ADR-014: hub commits only on hub/* branches, Code conventions (single package, erasable TS, JSON, Windows first), Definition of done, Hard rules (credentials, read-only stores, no push), Mission: local-first hub unifying agents, Models and effort policy, Repository map, Skills by situation table (+46 more)

### Community 3 - "prompt.md (pinned reconstruction prompt S1)"
Cohesion: 0.07
Nodes (50): tokens.css / tokens.json (generated), preview.html (live board of four themes), cardSheet (handoff card dialog), app click/change event handlers, compat / compatCell, decision (T016 decision card), diffSheet (changes-to-write dialog), dock (mobile bottom glass dock) (+42 more)

### Community 4 - "Optimization (OPTIMIZATION.md)"
Cohesion: 0.19
Nodes (13): Eleven practices to keep spend low, Optimization (OPTIMIZATION.md), Golden task set eval/golden, harness2 mechanisms adopted (probes, lessons, golden eval), Hypotheses to test first, Lessons with evidence (.hub/lessons), Three memory types (semantic, episodic, procedural), Two-level skills (profile of 15 + hub-skill-index) (+5 more)

### Community 5 - "store.ts"
Cohesion: 0.08
Nodes (48): db, t, Block, clip(), isNoise(), Line, syncClaude(), SyncStats (+40 more)

### Community 6 - "loading.ts"
Cohesion: 0.13
Nodes (29): compileAll(), compileMcpClaude(), compileMcpCodex(), compileRules(), compileSkill(), McpJson, mcpName(), projectType() (+21 more)

### Community 7 - "main.ts"
Cohesion: 0.23
Nodes (29): Args, BOOL, cmdConfig(), cmdGet(), cmdHooks(), cmdInit(), cmdInstall(), cmdMcp() (+21 more)

### Community 8 - "api.ts"
Cohesion: 0.11
Nodes (14): openLogin(), PICK_PS, pickFolder(), Desired, Body, clip(), entryView(), Handler (+6 more)

### Community 9 - "index.ts"
Cohesion: 0.20
Nodes (17): REPO_ROOT, ARCH, archDoc(), box(), build(), check(), dataDoc(), Doc (+9 more)

### Community 10 - "security.mjs"
Cohesion: 0.12
Nodes (17): all, code, dir, failed, files(), hits, inline, inner (+9 more)

### Community 11 - "Agent Hub — Project Specification & Delivery Plan"
Cohesion: 0.05
Nodes (37): 0. Document map, 10. Definition of Done (every task), 11. Risks and open questions, 12. Decisions so far (by the author), 1.1 Problem, 1.2 Product, 1.3 Users, 1.4 Goals / non-goals / anti-goals (+29 more)

### Community 12 - "install-remote.ts"
Cohesion: 0.26
Nodes (11): ALLOWED(), defaultTextFetcher(), planLibraryInstall(), Preview, previewComponent(), RawItem, relOk(), slug() (+3 more)

### Community 13 - "runner.ts"
Cohesion: 0.10
Nodes (35): fake, run(), withFake(), Block, brief(), claudeAdapter, PERMISSION, codexAdapter (+27 more)

### Community 14 - "build-tokens.mjs"
Cohesion: 0.29
Nodes (6): bridge, css, root, sel, shared, themes

### Community 15 - "effective"
Cohesion: 0.23
Nodes (11): adoptHooks(), AdoptResult, EVENT_MAP, tokenize(), classifyHooks(), ClaudeHooks, CODEX_KNOWN_EVENTS, HookReport (+3 more)

### Community 16 - "scout-remote.ts"
Cohesion: 0.21
Nodes (10): AitmplItem, defaultFetcher(), fetchAitmpl(), Fetcher, GhRunner, risk(), searchGithub(), sample (+2 more)

### Community 17 - "hub.js"
Cohesion: 0.50
Nodes (3): dist, hi, root

### Community 22 - "Agent Hub — архитектура"
Cohesion: 0.08
Nodes (25): 10. Технологический выбор (кратко, решения), 11. Порядок сборки, 12. Что не проверено и риски, 1. Зачем это нужно, 2. Цели, не-цели, анти-цели, 3. Принципы, 4.1. Ядро (`packages/core`), 4.2. Адаптеры (`packages/adapter-*`) (+17 more)

### Community 23 - "1. Файловые форматы"
Cohesion: 0.20
Nodes (10): 1.1. `hub.yaml` — проект, 1.2. `toolkit.yaml` — выбранные инструменты проекта (этап 3), 1.3. `hub.lock` — воспроизводимая установка, 1.4. Запись реестра `registry/entries/<kind>/<name>.yaml`, 1.5. Этап `stages/<name>.yaml`, 1.6. Карточка передачи `.hub/handoffs/<id>.md`, 1. Файловые форматы, 3. Связи (+2 more)

### Community 24 - "server.test.ts"
Cohesion: 0.14
Nodes (8): db, fake, fakeAgent, fakeExe, runs, scenario, sk, stub

### Community 25 - "plan.ts"
Cohesion: 0.21
Nodes (10): ProbeResult, probeStdio(), Server, dir, fakeServer, testProject(), ApplyResult, isLink() (+2 more)

### Community 26 - "locate.ts"
Cohesion: 0.18
Nodes (13): AuthInfo, authStatus(), cache, forgetAuth(), parseAuth(), Runner, AgentInfo, codexFromAppData() (+5 more)

### Community 30 - "profile.ts"
Cohesion: 0.43
Nodes (6): home(), listPlugins(), PluginInfo, skillCost(), suggest(), parseFrontmatter()

### Community 31 - "econ.ts"
Cohesion: 0.16
Nodes (18): ALIAS, Calib, calibrate(), canonicalModel(), CODEX_PRIOR, costUsd(), DEFAULT_PROFILE, estimate (+10 more)

### Community 32 - "RunManager"
Cohesion: 0.23
Nodes (4): Db, runHooks(), waitEnd(), RunManager

### Community 33 - "core/types.ts"
Cohesion: 0.16
Nodes (16): buildLock(), listPacks(), loadPack(), Pack, planInit(), library(), loadCatalog(), Candidate (+8 more)

### Community 34 - "hooks-run.ts"
Cohesion: 0.38
Nodes (10): approvalFile(), approvals(), approveRunnerHooks(), argvList(), digest(), empty(), HookResult, readRunnerHooks() (+2 more)

### Community 35 - "install-remote.test.ts"
Cohesion: 0.67
Nodes (3): catalog(), fake, fetcher()

### Community 36 - "loading.test.ts"
Cohesion: 0.67
Nodes (3): fake, mk(), skill()

### Community 37 - "AgentId"
Cohesion: 0.15
Nodes (15): LoadingAudit, SkillInfo, ToolRow, RootInfo, AgentId, AdviseIn, Choice, full() (+7 more)

### Community 38 - "registry.ts"
Cohesion: 0.28
Nodes (13): addSkillRoot(), loadUserConfig(), removeSkillRoot(), saveUserConfig(), scanLocalSkills(), skillDirs(), skillRootInfos(), skillRoots() (+5 more)

### Community 39 - "Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать"
Cohesion: 0.13
Nodes (14): 1. Главный вывод про токены, 2. Как устроена «инструменты только под проект», 3. Как это выглядит в панели, 4. Как запустить, 5. Аудит качества: что нашёл и исправил, 6. На что обратить внимание, 7. Идеи для доработки (по ценности), 8. Файлы (+6 more)

### Community 40 - "Models and limits (MODELS-AND-LIMITS.md)"
Cohesion: 0.27
Nodes (10): Graph (graphify) rules, Read order for a task (graph first), Token discipline, Models and limits (MODELS-AND-LIMITS.md), Two-week calibration plan, Claude API pricing table, Codex log findings (97.9 percent cache, 57 percent subagent tokens), Weekly limit percent cannot be derived by formula (+2 more)

### Community 41 - "AGENTS.md"
Cohesion: 0.20
Nodes (9): AGENTS.md, Definition of done, Hard rules, How to work, by kind of task, Models and effort, Save tokens, Skills by situation (use if installed), Start here (+1 more)

### Community 42 - "server.ts"
Cohesion: 0.31
Nodes (9): safeJoin(), bad(), handle(), cookieOf(), eqToken(), MIME, Started, startServer() (+1 more)

### Community 43 - "Agent Hub Design System v0.1"
Cohesion: 0.22
Nodes (9): Agent Hub Design System v0.1, Accent edge (light themes), Accent fill vs accent text rule, First component set (limit meter, handoff card, stage stepper, approval diff sheet), Measured contrast table, Material: opaque work surfaces, glass only for navigation, shadcn/ui variable bridge, Typography (Golos Text, JetBrains Mono) (+1 more)

### Community 44 - "Tooling for building the project (TOOLING.md)"
Cohesion: 0.36
Nodes (9): Honest limits of the study, MCP setup (Mobbin and shadcn), Mobbin MCP (OAuth, Streamable HTTP), shadcn MCP, Tooling for building the project (TOOLING.md), aitmpl catalog source, design-quality-loop skill, Hub's own skills (hub-init, hub-handoff, hub-estimate, ...) (+1 more)

### Community 45 - "engine.ts"
Cohesion: 0.50
Nodes (7): stagesDoc(), approvalsPath(), approveStage(), loadStages(), readApprovals(), Stage, stageStatus

### Community 46 - "2. Схема базы"
Cohesion: 0.25
Nodes (8): 2.1. Агенты и аккаунты, 2.2. Проекты и пути, 2.3. Сессии и сообщения (история обоих агентов), 2.4. Задачи, запуски, передачи, 2.5. Токены, лимиты, цены, 2.6. Экономика и калибровка, 2.7. Реестр и установки, 2. Схема базы

### Community 47 - "PLAN.md"
Cohesion: 0.47
Nodes (3): Schemes (SCHEMES.md), hub diagram command (generated from code, --check in CI), senior-architect skill

### Community 48 - "Model allocation (Opus 27 sessions, Sonnet 69)"
Cohesion: 0.50
Nodes (4): Codex as fallback when Claude Pro limit is hit, Escalation ladder and triggers, Model allocation (Opus 27 sessions, Sonnet 69), Model routing scheme

## Knowledge Gaps
- **254 isolated node(s):** `hi`, `root`, `dist`, `root`, `themes` (+249 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `advise()` connect `main.ts` to `api.ts`, `h`, `AgentId`, `econ.ts`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Why does `tasks()` connect `h` to `main.ts`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **What connects `hi`, `root`, `dist` to the rest of the system?**
  _254 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `h` be split into smaller, more focused modules?**
  _Cohesion score 0.08353838582677166 - nodes in this community are weakly interconnected._
- **Should `Agent Hub (local-first hub for coding agents)` be split into smaller, more focused modules?**
  _Cohesion score 0.06289308176100629 - nodes in this community are weakly interconnected._
- **Should `prompt.md (pinned reconstruction prompt S1)` be split into smaller, more focused modules?**
  _Cohesion score 0.07215686274509804 - nodes in this community are weakly interconnected._
- **Should `store.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07894736842105263 - nodes in this community are weakly interconnected._