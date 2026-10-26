# Graph Report - agent-hub  (2026-10-22)

## Corpus Check
- 106 files · ~75,671 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 769 nodes · 2101 edges · 30 communities (25 shown, 5 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 83 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- h
- runner.ts
- Agent Hub (local-first hub for coding agents)
- prompt.md (pinned reconstruction prompt S1)
- Tooling for building the project (TOOLING.md)
- store.ts
- plan.ts
- main.ts
- api.ts
- index.ts
- security.mjs
- Agent Hub — Project Specification & Delivery Plan
- registry.ts
- init.ts
- build-tokens.mjs
- hooks.ts
- core/types.ts
- hub.js
- fake-agent.mjs
- CLAUDE.md (pointer to AGENTS.md)
- Agent Hub — архитектура
- 2. Схема базы
- server.test.ts
- mcp-test.ts
- locate.ts
- core.test.ts
- install.test.ts
- hooks-adopt.test.ts

## God Nodes (most connected - your core abstractions)
1. `h()` - 72 edges
2. `main()` - 36 edges
3. `icon()` - 32 edges
4. `btn()` - 29 edges
5. `chip()` - 28 edges
6. `pageHead()` - 25 edges
7. `toast()` - 21 edges
8. `syncCodex()` - 20 edges
9. `redact()` - 20 edges
10. `empty()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `Agent Hub (local-first hub for coding agents)` --semantically_similar_to--> `Repository map`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `Screen intent: blocked-on-user first` --semantically_similar_to--> `Attention hierarchy: decision card primary`  [INFERRED] [semantically similar]
  design/research/STUDY.md → design/research/ux-plan-today.json
- `Safety model (localhost, read-only stores, plan-confirm writes)` --semantically_similar_to--> `Hard rules (credentials, read-only stores, no push)`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `tasks()` --indirect_call--> `advise()`  [INFERRED]
  web/js/views/project.js → src/econ/advisor.ts
- `Honest limits of the study` --conceptually_related_to--> `MCP setup (Mobbin and shadcn)`  [INFERRED]
  design/research/STUDY.md → docs/MCP-SETUP.md

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

## Communities (30 total, 5 thin omitted)

### Community 0 - "h"
Cohesion: 0.10
Nodes (91): api, call(), prefs, qs(), stream(), app, main, NAV (+83 more)

### Community 1 - "runner.ts"
Cohesion: 0.06
Nodes (61): fake, run(), withFake(), Block, brief(), claudeAdapter, PERMISSION, codexAdapter (+53 more)

### Community 2 - "Agent Hub (local-first hub for coding agents)"
Cohesion: 0.06
Nodes (55): ADR-014: hub commits only on hub/* branches, Code conventions (single package, erasable TS, JSON, Windows first), Definition of done, Hard rules (credentials, read-only stores, no push), Mission: local-first hub unifying agents, Models and effort policy, Repository map, Skills by situation table (+47 more)

### Community 3 - "prompt.md (pinned reconstruction prompt S1)"
Cohesion: 0.07
Nodes (50): tokens.css / tokens.json (generated), preview.html (live board of four themes), cardSheet (handoff card dialog), app click/change event handlers, compat / compatCell, decision (T016 decision card), diffSheet (changes-to-write dialog), dock (mobile bottom glass dock) (+42 more)

### Community 4 - "Tooling for building the project (TOOLING.md)"
Cohesion: 0.06
Nodes (47): Graph (graphify) rules, Read order for a task (graph first), Token discipline, Agent Hub Design System v0.1, Accent edge (light themes), Accent fill vs accent text rule, First component set (limit meter, handoff card, stage stepper, approval diff sheet), Measured contrast table (+39 more)

### Community 5 - "store.ts"
Cohesion: 0.06
Nodes (59): db, t, ALIAS, Calib, canonicalModel(), CODEX_PRIOR, costUsd(), DEFAULT_PROFILE (+51 more)

### Community 6 - "plan.ts"
Cohesion: 0.16
Nodes (22): compileMcpClaude(), compileMcpCodex(), compileRules(), McpJson, mcpName(), tomlStr(), adoptHooks(), EVENT_MAP (+14 more)

### Community 7 - "main.ts"
Cohesion: 0.19
Nodes (32): Args, BOOL, cmdHooks(), cmdInit(), cmdInstall(), cmdMcp(), cmdProfile(), cmdRun() (+24 more)

### Community 8 - "api.ts"
Cohesion: 0.10
Nodes (22): AgentInfo, REPO_ROOT, AgentId, Format, Kind, advise(), AdviseIn, Choice (+14 more)

### Community 9 - "index.ts"
Cohesion: 0.18
Nodes (21): ARCH, archDoc(), box(), build(), check(), dataDoc(), Doc, Graph (+13 more)

### Community 10 - "security.mjs"
Cohesion: 0.12
Nodes (17): all, code, dir, failed, files(), hits, inline, inner (+9 more)

### Community 11 - "Agent Hub — Project Specification & Delivery Plan"
Cohesion: 0.05
Nodes (37): 0. Document map, 10. Definition of Done (every task), 11. Risks and open questions, 12. Decisions so far (by the author), 1.1 Problem, 1.2 Product, 1.3 Users, 1.4 Goals / non-goals / anti-goals (+29 more)

### Community 12 - "registry.ts"
Cohesion: 0.14
Nodes (25): cmdConfig(), addSkillRoot(), loadCatalog(), loadUserConfig(), removeSkillRoot(), saveUserConfig(), scanLocalSkills(), skillDirs() (+17 more)

### Community 13 - "init.ts"
Cohesion: 0.21
Nodes (15): compileAll(), compileSkill(), AdoptResult, buildLock(), listPacks(), loadPack(), Pack, planInit() (+7 more)

### Community 14 - "build-tokens.mjs"
Cohesion: 0.29
Nodes (6): bridge, css, root, sel, shared, themes

### Community 15 - "hooks.ts"
Cohesion: 0.47
Nodes (5): classifyHooks(), ClaudeHooks, CODEX_KNOWN_EVENTS, HookReport, Compat

### Community 16 - "core/types.ts"
Cohesion: 0.14
Nodes (17): Candidate, AitmplItem, defaultFetcher(), fetchAitmpl(), Fetcher, GhRunner, risk(), searchGithub() (+9 more)

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
Nodes (7): db, fake, fakeAgent, fakeExe, runs, scenario, sk

### Community 25 - "mcp-test.ts"
Cohesion: 0.36
Nodes (6): ProbeResult, probeStdio(), Server, dir, fakeServer, testProject()

### Community 26 - "locate.ts"
Cohesion: 0.60
Nodes (5): codexFromAppData(), detectAgents(), locate(), onPath(), resolveShim()

## Knowledge Gaps
- **209 isolated node(s):** `hi`, `root`, `dist`, `root`, `themes` (+204 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `advise()` connect `api.ts` to `h`, `store.ts`, `main.ts`?**
  _High betweenness centrality (0.133) - this node is a cross-community bridge._
- **Why does `tasks()` connect `h` to `api.ts`?**
  _High betweenness centrality (0.132) - this node is a cross-community bridge._
- **What connects `hi`, `root`, `dist` to the rest of the system?**
  _209 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `h` be split into smaller, more focused modules?**
  _Cohesion score 0.10192205960148122 - nodes in this community are weakly interconnected._
- **Should `runner.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05903866248693835 - nodes in this community are weakly interconnected._
- **Should `Agent Hub (local-first hub for coding agents)` be split into smaller, more focused modules?**
  _Cohesion score 0.06127946127946128 - nodes in this community are weakly interconnected._
- **Should `prompt.md (pinned reconstruction prompt S1)` be split into smaller, more focused modules?**
  _Cohesion score 0.07215686274509804 - nodes in this community are weakly interconnected._