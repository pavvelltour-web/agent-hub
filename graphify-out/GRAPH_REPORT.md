# Graph Report - agent-hub  (2026-10-23)

## Corpus Check
- 126 files · ~98,945 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 938 nodes · 2548 edges · 45 communities (36 shown, 9 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 83 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- h
- compilers.ts
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
- runner.ts
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
- AgentId
- core.test.ts
- install.test.ts
- hooks-adopt.test.ts
- econ.test.ts
- econ.ts
- RunManager
- core/types.ts
- install-remote.test.ts
- loading.test.ts
- registry.ts
- Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать
- AGENTS.md
- server.ts
- engine.ts
- automation.md
- design-study.md
- mobile-app.md
- web-saas.md

## God Nodes (most connected - your core abstractions)
1. `h()` - 75 edges
2. `main()` - 38 edges
3. `btn()` - 35 edges
4. `icon()` - 31 edges
5. `chip()` - 31 edges
6. `AgentId` - 28 edges
7. `pageHead()` - 25 edges
8. `toast()` - 23 edges
9. `readText()` - 22 edges
10. `empty()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Agent Hub (local-first hub for coding agents)` --semantically_similar_to--> `Repository map`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `Honest limits of the study` --conceptually_related_to--> `MCP setup (Mobbin and shadcn)`  [INFERRED]
  design/research/STUDY.md → docs/MCP-SETUP.md
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

## Communities (45 total, 9 thin omitted)

### Community 0 - "h"
Cohesion: 0.08
Nodes (115): api, call(), prefs, qs(), stream(), app, main, NAV (+107 more)

### Community 1 - "compilers.ts"
Cohesion: 0.27
Nodes (12): compileAll(), compileMcpClaude(), compileMcpCodex(), compileRules(), compileSkill(), McpJson, mcpName(), projectType() (+4 more)

### Community 2 - "Agent Hub (local-first hub for coding agents)"
Cohesion: 0.06
Nodes (55): ADR-014: hub commits only on hub/* branches, Code conventions (single package, erasable TS, JSON, Windows first), Definition of done, Hard rules (credentials, read-only stores, no push), Mission: local-first hub unifying agents, Models and effort policy, Repository map, Skills by situation table (+47 more)

### Community 3 - "prompt.md (pinned reconstruction prompt S1)"
Cohesion: 0.07
Nodes (51): tokens.css / tokens.json (generated), preview.html (live board of four themes), cardSheet (handoff card dialog), app click/change event handlers, compat / compatCell, decision (T016 decision card), diffSheet (changes-to-write dialog), dock (mobile bottom glass dock) (+43 more)

### Community 4 - "Tooling for building the project (TOOLING.md)"
Cohesion: 0.07
Nodes (46): Graph (graphify) rules, Read order for a task (graph first), Token discipline, Agent Hub Design System v0.1, Accent edge (light themes), Accent fill vs accent text rule, First component set (limit meter, handoff card, stage stepper, approval diff sheet), Measured contrast table (+38 more)

### Community 5 - "store.ts"
Cohesion: 0.08
Nodes (45): db, t, Block, clip(), isNoise(), Line, syncClaude(), SyncStats (+37 more)

### Community 6 - "loading.ts"
Cohesion: 0.14
Nodes (24): auditLoading(), CLAUDE_FILE, ClaudeLocal, CodexBlock, compileProfile(), Desired, LoadingAudit, mcpNamesClaude() (+16 more)

### Community 7 - "main.ts"
Cohesion: 0.22
Nodes (30): Args, BOOL, cmdConfig(), cmdGet(), cmdHooks(), cmdInit(), cmdInstall(), cmdMcp() (+22 more)

### Community 8 - "api.ts"
Cohesion: 0.12
Nodes (11): openLogin(), PICK_PS, pickFolder(), Body, clip(), entryView(), Handler, HttpError (+3 more)

### Community 9 - "index.ts"
Cohesion: 0.18
Nodes (18): REPO_ROOT, ARCH, archDoc(), box(), build(), check(), dataDoc(), Doc (+10 more)

### Community 10 - "security.mjs"
Cohesion: 0.12
Nodes (17): all, code, dir, failed, files(), hits, inline, inner (+9 more)

### Community 11 - "Agent Hub — Project Specification & Delivery Plan"
Cohesion: 0.05
Nodes (37): 0. Document map, 10. Definition of Done (every task), 11. Risks and open questions, 12. Decisions so far (by the author), 1.1 Problem, 1.2 Product, 1.3 Users, 1.4 Goals / non-goals / anti-goals (+29 more)

### Community 12 - "install-remote.ts"
Cohesion: 0.27
Nodes (10): ALLOWED(), defaultTextFetcher(), planLibraryInstall(), Preview, previewComponent(), RawItem, relOk(), slug() (+2 more)

### Community 13 - "runner.ts"
Cohesion: 0.06
Nodes (68): fake, run(), withFake(), Block, brief(), claudeAdapter, PERMISSION, codexAdapter (+60 more)

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

### Community 26 - "AgentId"
Cohesion: 0.18
Nodes (14): AuthInfo, authStatus(), cache, forgetAuth(), parseAuth(), Runner, AgentInfo, codexFromAppData() (+6 more)

### Community 30 - "econ.test.ts"
Cohesion: 0.43
Nodes (5): calibrate(), estimate, pct(), profileFromHistory(), weighted()

### Community 31 - "econ.ts"
Cohesion: 0.06
Nodes (53): advise(), AdviseIn, Choice, EXPLORABLE, full(), GPT_EFFORT, left(), LimitState (+45 more)

### Community 32 - "RunManager"
Cohesion: 0.24
Nodes (3): Db, waitEnd(), RunManager

### Community 33 - "core/types.ts"
Cohesion: 0.14
Nodes (24): detectAgents(), adoptHooks(), AdoptResult, EVENT_MAP, tokenize(), buildLock(), listPacks(), loadPack() (+16 more)

### Community 35 - "install-remote.test.ts"
Cohesion: 0.67
Nodes (3): catalog(), fake, fetcher()

### Community 36 - "loading.test.ts"
Cohesion: 0.67
Nodes (3): fake, mk(), skill()

### Community 38 - "registry.ts"
Cohesion: 0.24
Nodes (15): addSkillRoot(), loadCatalog(), loadUserConfig(), removeSkillRoot(), saveUserConfig(), scanLocalSkills(), skillDirs(), skillRootInfos() (+7 more)

### Community 39 - "Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать"
Cohesion: 0.11
Nodes (18): 1. Адаптировано ли использование токенов, 1. Главный вывод про токены, 2. Выбор модели: не правило, а ближайшая точка к идеалу, 2. Как устроена «инструменты только под проект», 3. Как это выглядит в панели, 3. Сбор данных пользователей с согласия, 4. Как запустить, 5. Аудит качества: что нашёл и исправил (+10 more)

### Community 41 - "AGENTS.md"
Cohesion: 0.20
Nodes (9): AGENTS.md, Definition of done, Hard rules, How to work, by kind of task, Models and effort, Save tokens, Skills by situation (use if installed), Start here (+1 more)

### Community 42 - "server.ts"
Cohesion: 0.31
Nodes (9): safeJoin(), bad(), handle(), cookieOf(), eqToken(), MIME, Started, startServer() (+1 more)

### Community 45 - "engine.ts"
Cohesion: 0.50
Nodes (7): stagesDoc(), approvalsPath(), approveStage(), loadStages(), readApprovals(), Stage, stageStatus

## Knowledge Gaps
- **264 isolated node(s):** `hi`, `root`, `dist`, `root`, `themes` (+259 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `advise()` connect `econ.ts` to `api.ts`, `h`, `econ.test.ts`, `main.ts`?**
  _High betweenness centrality (0.115) - this node is a cross-community bridge._
- **Why does `tasks()` connect `h` to `econ.ts`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **What connects `hi`, `root`, `dist` to the rest of the system?**
  _264 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `h` be split into smaller, more focused modules?**
  _Cohesion score 0.08038399259773306 - nodes in this community are weakly interconnected._
- **Should `Agent Hub (local-first hub for coding agents)` be split into smaller, more focused modules?**
  _Cohesion score 0.06127946127946128 - nodes in this community are weakly interconnected._
- **Should `prompt.md (pinned reconstruction prompt S1)` be split into smaller, more focused modules?**
  _Cohesion score 0.07013574660633484 - nodes in this community are weakly interconnected._
- **Should `Tooling for building the project (TOOLING.md)` be split into smaller, more focused modules?**
  _Cohesion score 0.06547619047619048 - nodes in this community are weakly interconnected._