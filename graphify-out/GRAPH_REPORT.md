# Graph Report - agent-hub  (2026-10-28)

## Corpus Check
- 305 files · ~339,387 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2654 nodes · 7129 edges · 155 communities (134 shown, 21 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 179 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `62af463e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- btn
- transcript.js
- Agent Hub (local-first hub for coding agents)
- prompt.md (pinned reconstruction prompt S1)
- Tooling for building the project (TOOLING.md)
- history/store.ts
- loading.ts
- main.ts
- api.ts
- index.ts
- security.mjs
- Agent Hub — Project Specification & Delivery Plan
- adapters/claude.ts
- runner.ts
- build-tokens.mjs
- review.js
- core/types.ts
- hub.js
- fake-agent.mjs
- CLAUDE.md (pointer to AGENTS.md)
- Agent Hub — архитектура
- agents.ts
- server.test.ts
- AgentId
- probe.ts
- core.test.ts
- install.test.ts
- hooks-adopt.test.ts
- history/codex.ts
- cases.test.ts
- RunManager
- init.ts
- router.ts
- install-remote.test.ts
- loading.test.ts
- eval.ts
- starter.ts
- Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать
- git.ts
- AGENTS.md
- adapters/codex.ts
- workmodes.ts
- Optimization (OPTIMIZATION.md)
- gate.ts
- Models and limits (MODELS-AND-LIMITS.md)
- hooks-run.ts
- trace.ts
- registry.ts
- h
- common.js
- checks.ts
- cascade.ts
- project.js
- context.ts
- gate.test.ts
- econ.ts
- review/store.ts
- prices.ts
- review/types.ts
- breaker.ts
- autouse.ts
- greet.js
- Account
- unique.test.js
- sum.js
- chunk.js
- slug.js
- legacy.js
- cache.js
- scheduler.test.ts
- context-gauge.js
- source.ts
- forecast.js
- phase7-api.ts
- adr/README.md
- strategies.ts
- autouse.js
- graph.ts
- scheduler.ts
- integrity.ts
- priors.ts
- ui.js
- autouse-wire.ts
- 2. Схема базы
- cascade.test.ts
- bench.ts
- Db
- cascade-api.test.ts
- logs.js
- ADR-019: mandatory review gate with verifier votes; only a human approval counts
- trace-model.js
- checks.test.ts
- runCheck
- phase7-api.test.ts
- Agent Hub v0.2 Implementation Plan
- risk.ts
- guard-model.js
- ADR-017: verify-and-escalate cascade
- readReviewConfig
- phase7-round2-api.test.ts
- Phase PR — Mandatory thorough review (a gate, not an option)
- starter.test.ts
- trace-review-api.test.ts
- Workflow (one task, one worktree, test first)
- Phase 3 — Model and effort routing toward the ideal
- start.test.ts
- breaker.test.ts
- 8. Iteration plan
- package-check.ts
- Phase 7 — Observability and forecasting
- automation/REVIEW.md
- design-study/REVIEW.md
- mobile-app/REVIEW.md
- web-saas/REVIEW.md
- init.test.ts
- templates.test.ts
- breaker-round2.test.ts
- integrity.test.ts
- {{name}}: архитектура
- {{name}}: архитектура
- {{name}}: архитектура
- {{name}}: архитектура
- chip
- Phase 2 — Chat and history like the real CLIs
- Phase 4 — Token economy
- Phase 5 — Fastest entry: starter kit
- screen-model.test.ts
- {{name}}: бриф
- {{name}}: бриф
- {{name}}: бриф
- {{name}}: бриф
- Phase 1 — Modes that really work
- ADR-025: using the leftover limit before a reset is opt-in per project, starts only what the user approved, and fails closed
- ADR-026: the circuit breaker stops runaway runs, is ON by default, and only the user's own config can loosen it
- Adapter fixtures
- templates-paths.test.ts
- cascade-model.test.ts
- trace-model.test.ts
- keepalive.test.ts
- ADR-016: one process per chat message (`--resume`), a persistent process is not adopted yet
- automation.md
- design-study.md
- mobile-app.md
- web-saas.md
- integrity-worker.mjs

## God Nodes (most connected - your core abstractions)
1. `h()` - 141 edges
2. `btn()` - 58 edges
3. `AgentId` - 56 edges
4. `redact()` - 55 edges
5. `chip()` - 54 edges
6. `RunManager` - 47 edges
7. `icon()` - 42 edges
8. `main()` - 41 edges
9. `runRound()` - 40 edges
10. `toast()` - 40 edges

## Surprising Connections (you probably didn't know these)
- `Agent Hub (local-first hub for coding agents)` --semantically_similar_to--> `Repository map`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `Models and effort policy` --references--> `Security and vulnerability checks (SECURITY.md)`  [INFERRED]
  AGENTS.md → docs/SECURITY.md
- `Screen intent: blocked-on-user first` --semantically_similar_to--> `Attention hierarchy: decision card primary`  [INFERRED] [semantically similar]
  design/research/STUDY.md → design/research/ux-plan-today.json
- `Safety model (localhost, read-only stores, plan-confirm writes)` --semantically_similar_to--> `Hard rules (credentials, read-only stores, no push)`  [INFERRED] [semantically similar]
  README.md → AGENTS.md
- `files()` --indirect_call--> `n()`  [INFERRED]
  scripts/security.mjs → src/econ/skills-estimate.ts

## Import Cycles
- 3-file cycle: `src/core/workmodes.ts -> src/run/runner.ts -> src/run/lean.ts -> src/core/workmodes.ts`

## Hyperedges (group relationships)
- **Zero-dependency stack decisions** — docs_adr_010_single_package_zero_deps, docs_adr_011_json_instead_of_yaml, docs_adr_012_panel_without_react, docs_adr_013_typescript_type_stripping [EXTRACTED 1.00]
- **Safe handoff and run chain** — readme_handoff, adr_014_hub_commits_only_on_own_branches, docs_adr_015_prompt_through_stdin, readme_push_guard [INFERRED 0.85]
- **Unverified claims and limits cluster** — docs_status_codex_success_path_unverified, docs_status_claude_rate_limit_event_unseen, docs_status_docker_scanners_not_run, docs_status_untested_platforms, docs_status_terms_of_use_unchecked [INFERRED 0.85]
- **Prototype S1 render pipeline** — design_prototypes_app_render, design_prototypes_app_today, design_prototypes_app_task, design_prototypes_app_toolkit, design_prototypes_app_rail, design_prototypes_app_tablens, design_prototypes_app_dock [EXTRACTED 0.95]
- **Study S1 design loop (prompt, build, review, revise)** — design_research_prompt, design_research_ux_plan_today, design_research_study, design_prototypes_app, design_research_review, design_research_revisions [INFERRED 0.85]
- **Handoff card dialog flow** — design_prototypes_app_click_handler, design_prototypes_app_opensheet, design_prototypes_app_cardsheet, design_research_ux_plan_today_controls [INFERRED 0.75]
- **Token and cost reduction measures validated by A/B** — docs_optimization_stable_prefix, docs_optimization_two_level_skills, docs_tooling_ponytail, docs_tooling_graphify, docs_optimization_golden_task_set, docs_tooling_token_saving_measures [INFERRED 0.85]
- **Four-theme design system pipeline** — design_design_system_tokens_css, design_design_system_shadcn_bridge, design_design_system_contrast_measurements, design_preview [INFERRED 0.85]

## Communities (155 total, 21 thin omitted)

### Community 0 - "btn"
Cohesion: 0.14
Nodes (45): n(), label(), api, call(), prefs, qs(), stream(), navLink() (+37 more)

### Community 1 - "transcript.js"
Cohesion: 0.13
Nodes (38): argFor(), bodyView(), corner(), diffLine(), diffRow(), duration(), errRes(), FAMILY (+30 more)

### Community 2 - "Agent Hub (local-first hub for coding agents)"
Cohesion: 0.07
Nodes (43): ADR-014: hub commits only on hub/* branches, Hard rules (credentials, read-only stores, no push), Mission: local-first hub unifying agents, Repository map, UI rules (tokens, four themes, sizes), ADR-015: prompt goes through stdin, never arguments, Security and vulnerability checks (SECURITY.md), Third-party component risk assessment (+35 more)

### Community 3 - "prompt.md (pinned reconstruction prompt S1)"
Cohesion: 0.07
Nodes (50): tokens.css / tokens.json (generated), preview.html (live board of four themes), cardSheet (handoff card dialog), app click/change event handlers, compat / compatCell, decision (T016 decision card), diffSheet (changes-to-write dialog), dock (mobile bottom glass dock) (+42 more)

### Community 4 - "Tooling for building the project (TOOLING.md)"
Cohesion: 0.14
Nodes (21): Agent Hub Design System v0.1, Accent edge (light themes), Accent fill vs accent text rule, First component set (limit meter, handoff card, stage stepper, approval diff sheet), Measured contrast table, Material: opaque work surfaces, glass only for navigation, shadcn/ui variable bridge, Typography (Golos Text, JetBrains Mono) (+13 more)

### Community 5 - "history/store.ts"
Cohesion: 0.06
Nodes (36): db, t, job, NOW, snap(), cf, claudeDir, codexDir (+28 more)

### Community 6 - "loading.ts"
Cohesion: 0.11
Nodes (28): auditLoading(), CLAUDE_FILE, ClaudeLocal, CodexBlock, compileProfile(), Desired, mcpNamesClaude(), mcpNamesCodex() (+20 more)

### Community 7 - "main.ts"
Cohesion: 0.14
Nodes (45): authStatus(), authStatusIn(), parseAuth(), detectAgents(), parsePicks(), summarize(), Args, BOOL (+37 more)

### Community 8 - "api.ts"
Cohesion: 0.06
Nodes (34): AuthInfo, cache, forgetAuth(), Runner, RunnerIn, AgentInfo, codexFromAppData(), locate() (+26 more)

### Community 9 - "index.ts"
Cohesion: 0.14
Nodes (26): REPO_ROOT, ARCH, archDoc(), box(), build(), check(), dataDoc(), Doc (+18 more)

### Community 10 - "security.mjs"
Cohesion: 0.12
Nodes (17): all, code, dir, failed, files(), hits, inline, inner (+9 more)

### Community 11 - "Agent Hub — Project Specification & Delivery Plan"
Cohesion: 0.07
Nodes (29): 0. Document map, 10. Definition of Done (every task), 11. Risks and open questions, 12. Decisions so far (by the author), 1.1 Problem, 1.2 Product, 1.3 Users, 1.4 Goals / non-goals / anti-goals (+21 more)

### Community 12 - "adapters/claude.ts"
Cohesion: 0.17
Nodes (25): Block, brief(), ClaudeLine, parseLine(), resultText(), ADR-0024, parseLine(), asInput() (+17 more)

### Community 13 - "runner.ts"
Cohesion: 0.13
Nodes (25): fake, run(), ADR-0024, withFake(), RunHandle, startAgent(), StartOpts, AgentAdapter (+17 more)

### Community 14 - "build-tokens.mjs"
Cohesion: 0.29
Nodes (6): bridge, css, root, sel, shared, themes

### Community 15 - "review.js"
Cohesion: 0.06
Nodes (62): api(), db, fakeAgent, fakeExe, home, hubHome, raw(), root (+54 more)

### Community 16 - "core/types.ts"
Cohesion: 0.09
Nodes (29): adoptHooks(), AdoptResult, EVENT_MAP, tokenize(), classifyHooks(), ClaudeHooks, CODEX_KNOWN_EVENTS, HookReport (+21 more)

### Community 17 - "hub.js"
Cohesion: 0.50
Nodes (3): dist, hi, root

### Community 22 - "Agent Hub — архитектура"
Cohesion: 0.08
Nodes (25): 10. Технологический выбор (кратко, решения), 11. Порядок сборки, 12. Что не проверено и риски, 1. Зачем это нужно, 2. Цели, не-цели, анти-цели, 3. Принципы, 4.1. Ядро (`packages/core`), 4.2. Адаптеры (`packages/adapter-*`) (+17 more)

### Community 23 - "agents.ts"
Cohesion: 0.07
Nodes (46): ADR-0010, Pick, block(), buildHuntPrompt(), buildVerifyPrompt(), Common, ctx(), dataRule() (+38 more)

### Community 24 - "server.test.ts"
Cohesion: 0.12
Nodes (13): api(), db, fake, fakeAgent, fakeExe, graphCtx, runs, scenario (+5 more)

### Community 25 - "AgentId"
Cohesion: 0.07
Nodes (46): Pick, LoadingAudit, SkillInfo, ToolRow, RootInfo, AgentId, Classified, classify() (+38 more)

### Community 26 - "probe.ts"
Cohesion: 0.19
Nodes (13): Capability, classify(), Ev, IS_TOOL, loadMatrix(), ModeMatrix, probeModes(), repo() (+5 more)

### Community 27 - "core.test.ts"
Cohesion: 0.18
Nodes (3): fake, gtmp, ADR-0021

### Community 30 - "history/codex.ts"
Cohesion: 0.11
Nodes (38): Block, clip(), historyLineEvents(), isNoise(), Line, readSessionEvents(), syncClaude(), SyncStats (+30 more)

### Community 31 - "cases.test.ts"
Cohesion: 0.19
Nodes (13): bucket(), buildCases(), bundle(), Case, exportCases(), installId(), isoWeek(), NEVER_INCLUDED (+5 more)

### Community 32 - "RunManager"
Cohesion: 0.10
Nodes (20): BenchOpts, waitEnd(), isGitRepo(), chain(), ChainRow, ctxRun(), fake, fakeExe (+12 more)

### Community 33 - "init.ts"
Cohesion: 0.09
Nodes (45): compileAll(), compileMcpClaude(), compileMcpCodex(), compileRules(), compileSkill(), McpJson, mcpName(), projectType() (+37 more)

### Community 34 - "router.ts"
Cohesion: 0.11
Nodes (36): advise(), AdviseIn, Choice, EFFORT_RU, EXPLORABLE, FAMILY_RU, full(), GPT_EFFORT (+28 more)

### Community 35 - "install-remote.test.ts"
Cohesion: 0.67
Nodes (3): catalog(), fake, fetcher()

### Community 36 - "loading.test.ts"
Cohesion: 0.67
Nodes (3): fake, mk(), skill()

### Community 37 - "eval.ts"
Cohesion: 0.08
Nodes (41): answerCounts(), ANSWERS, Baseline, BLOCKING, caseFromFinding(), CaseResult, caseSummary, checkMeta() (+33 more)

### Community 38 - "starter.ts"
Cohesion: 0.09
Nodes (36): defaultTextFetcher, makeTextFetcher(), planLibraryInstall(), Preview, previewComponent(), RawItem, relOk(), slug() (+28 more)

### Community 39 - "Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать"
Cohesion: 0.11
Nodes (18): 1. Адаптировано ли использование токенов, 1. Главный вывод про токены, 2. Выбор модели: не правило, а ближайшая точка к идеалу, 2. Как устроена «инструменты только под проект», 3. Как это выглядит в панели, 3. Сбор данных пользователей с согласия, 4. Как запустить, 5. Аудит качества: что нашёл и исправил (+10 more)

### Community 40 - "git.ts"
Cohesion: 0.19
Nodes (18): hiddenEntries(), gitc(), repoWithWorktree(), sh(), ALLOWED_ENV, branchName(), checkpoint(), checkSparse() (+10 more)

### Community 41 - "AGENTS.md"
Cohesion: 0.20
Nodes (9): AGENTS.md, Definition of done, Hard rules, How to work, by kind of task, Models and effort, Save tokens, Skills by situation (use if installed), Start here (+1 more)

### Community 42 - "adapters/codex.ts"
Cohesion: 0.13
Nodes (14): claudeAdapter, codexAdapter, CodexLine, Item, MONTHS, parseResetTime(), dir, feed() (+6 more)

### Community 43 - "workmodes.ts"
Cohesion: 0.06
Nodes (45): loadCatalog(), readCatalogDir(), shippedCatalogIds(), AGENTS, AP_DEPTHS, AP_MODES, ApplyOpts, applyWorkMode() (+37 more)

### Community 44 - "Optimization (OPTIMIZATION.md)"
Cohesion: 0.19
Nodes (13): Eleven practices to keep spend low, Optimization (OPTIMIZATION.md), Golden task set eval/golden, harness2 mechanisms adopted (probes, lessons, golden eval), Hypotheses to test first, Lessons with evidence (.hub/lessons), Three memory types (semantic, episodic, procedural), Two-level skills (profile of 15 + hub-skill-index) (+5 more)

### Community 45 - "gate.ts"
Cohesion: 0.10
Nodes (43): diffTooLarge(), approveChecks(), planChecks(), answer(), approve(), approveReviewChecks(), blockers(), BLOCKING_SEVERITY (+35 more)

### Community 46 - "Models and limits (MODELS-AND-LIMITS.md)"
Cohesion: 0.27
Nodes (10): Models and limits (MODELS-AND-LIMITS.md), Two-week calibration plan, Claude API pricing table, Codex as fallback when Claude Pro limit is hit, Codex log findings (97.9 percent cache, 57 percent subagent tokens), Escalation ladder and triggers, Weekly limit percent cannot be derived by formula, Model allocation (Opus 27 sessions, Sonnet 69) (+2 more)

### Community 47 - "hooks-run.ts"
Cohesion: 0.38
Nodes (10): approvalFile(), approvals(), approveRunnerHooks(), argvList(), digest(), empty(), HookResult, readRunnerHooks() (+2 more)

### Community 48 - "trace.ts"
Cohesion: 0.08
Nodes (34): BenchRow, file, g, clock(), mk(), Tokens, buildTrace(), cachedTrace() (+26 more)

### Community 49 - "registry.ts"
Cohesion: 0.10
Nodes (35): ApplyResult, addSkillRoot(), loadUserConfig(), removeSkillRoot(), saveUserConfig(), scanLocalSkills(), skillDirs(), skillRootInfos() (+27 more)

### Community 50 - "h"
Cohesion: 0.15
Nodes (34): lanes(), msText(), avatar(), debounce(), empty(), h(), chatPanel(), view() (+26 more)

### Community 51 - "common.js"
Cohesion: 0.15
Nodes (29): renderRun(), renderSafe(), agentBadge(), agentName(), copy(), meter(), PERMS, addProjectDialog() (+21 more)

### Community 52 - "checks.ts"
Cohesion: 0.10
Nodes (32): AddedDep, addedDependencies(), buildPlan(), CheckOpts, CopyError, dependencyFindings(), digestOf(), fileLike() (+24 more)

### Community 53 - "cascade.ts"
Cohesion: 0.13
Nodes (31): run(), CheckPlan, diffArgs(), block(), CascadeOpts, CascadeResult, CascadeState, clip() (+23 more)

### Community 54 - "project.js"
Cohesion: 0.12
Nodes (30): field(), sectionHead(), svgEl(), modelName(), pctText(), runRow(), shortModel(), TASKS (+22 more)

### Community 55 - "context.ts"
Cohesion: 0.10
Nodes (27): ADR-0014, Breakdown, Cache, cacheState(), contextBreakdown(), contextChainDepth(), contextLevel(), ctxOf() (+19 more)

### Community 56 - "gate.test.ts"
Cohesion: 0.10
Nodes (26): q(), sweepReviewerDirs(), sweepCheckRuns(), GateError, launchReview(), startReview(), apiOf(), baseOf() (+18 more)

### Community 57 - "econ.ts"
Cohesion: 0.19
Nodes (24): ALIAS, calibrate(), canonicalModel(), CODEX_PRIOR, costUsd(), DEFAULT_PROFILE, effortProfile(), effortProfiles() (+16 more)

### Community 58 - "review/store.ts"
Cohesion: 0.14
Nodes (27): begin(), reviewsOfRun(), addFindings(), answerFinding(), clearHumanApproval(), createReview(), FindingRow, listFindings() (+19 more)

### Community 59 - "prices.ts"
Cohesion: 0.14
Nodes (26): PRICES_VERIFIED_AT, badId(), bundledCheckedAt(), DEFAULT_PRICES_PATH, isObj(), loadPriceTable(), money(), NONE (+18 more)

### Community 60 - "review/types.ts"
Cohesion: 0.13
Nodes (23): sha256(), fnd(), put(), rawF(), stored(), clip(), count(), DiffLine (+15 more)

### Community 61 - "breaker.ts"
Cohesion: 0.16
Nodes (27): ackFile(), ackTrip(), blockingTrips(), Caps, capsProblem(), chainDepth(), effectiveCaps(), evaluate() (+19 more)

### Community 62 - "autouse.ts"
Cohesion: 0.13
Nodes (25): AutoDeps, AutoItem, AutoProject, AutoState, cancelItem(), clip(), emptyState(), fin() (+17 more)

### Community 63 - "greet.js"
Cohesion: 0.60
Nodes (3): greet(), getUsr(), users

### Community 71 - "scheduler.test.ts"
Cohesion: 0.18
Nodes (22): confirmWordFor(), acquireLock(), body(), file(), heartbeat(), holdsLock(), Lock, LockDeps (+14 more)

### Community 75 - "context-gauge.js"
Cohesion: 0.14
Nodes (23): AGENTS, cacheLine(), contextModel(), gaugeText(), HANDOFFS, INVISIBLE, ADR-0018, levelChip() (+15 more)

### Community 76 - "source.ts"
Cohesion: 0.50
Nodes (3): real(), resolveSource(), Source

### Community 77 - "forecast.js"
Cohesion: 0.17
Nodes (24): AGENT_RU, AGENTS, BASES, basisText(), forecastLine(), forecastModel(), INVISIBLE, LABELS (+16 more)

### Community 78 - "phase7-api.ts"
Cohesion: 0.09
Nodes (18): auditGuard(), CAP_RANGE, DEFAULT_CAPS, NUM_KEYS, JobKind, KIND_RU, KIND_WRITES, Handler (+10 more)

### Community 79 - "adr/README.md"
Cohesion: 0.12
Nodes (16): Code conventions (single package, erasable TS, JSON, Windows first), ADR-010: one package, zero runtime dependencies, ADR-011: JSON file formats instead of YAML, ADR-012: panel is plain ES modules, no React, no bundler, ADR-013: TypeScript via Node type stripping, tsc build for publishing, ADR-018: a task run past 250K tokens of context is stopped and continued in a fresh session from its handoff card, ADR-020: a run starts only the skills and MCP servers its work mode needs, ADR-021: the project graph is built by a bounded `graphify update` the user starts (+8 more)

### Community 80 - "strategies.ts"
Cohesion: 0.14
Nodes (17): cascade(), Cell, CLASSES, compareStrategies(), fromBench(), fromOutcomes(), isBench(), keyOf() (+9 more)

### Community 81 - "autouse.js"
Cohesion: 0.19
Nodes (21): AGENTS, agentText(), autoModel(), confirmMatches(), fin(), hoursText(), INVISIBLE, KIND_RU (+13 more)

### Community 82 - "graph.ts"
Cohesion: 0.16
Nodes (21): killTree(), ALWAYS_SKIP, envPath(), globSeg(), GRAPHIGNORE, GraphLast, GraphState, graphStatus (+13 more)

### Community 83 - "scheduler.ts"
Cohesion: 0.15
Nodes (21): approveItem(), isEnabled(), projectKeyOf(), AGENTS, BILLING_ENV, billingOk(), eligibility(), exists() (+13 more)

### Community 84 - "integrity.ts"
Cohesion: 0.20
Nodes (21): auditName(), canon(), fileState(), guardrailsConfigTrusted(), hashFile(), hasTamper(), readJson(), recordTamper() (+13 more)

### Community 85 - "priors.ts"
Cohesion: 0.16
Nodes (18): basisOf(), CLASSES, common(), DEFAULT_PRIORS_PATH, isObj(), isoDate(), loadPriors(), MODELS (+10 more)

### Community 86 - "ui.js"
Cohesion: 0.15
Nodes (18): app, main, NAV, navKey(), route(), ROUTES, section(), add() (+10 more)

### Community 87 - "autouse-wire.ts"
Cohesion: 0.16
Nodes (17): AutoScheduler, base, fake, fakeExe, home, repo, ownStartMs(), pidAlive() (+9 more)

### Community 88 - "2. Схема базы"
Cohesion: 0.11
Nodes (18): 1.1. `hub.yaml` — проект, 1.2. `toolkit.yaml` — выбранные инструменты проекта (этап 3), 1.3. `hub.lock` — воспроизводимая установка, 1.4. Запись реестра `registry/entries/<kind>/<name>.yaml`, 1.5. Этап `stages/<name>.yaml`, 1.6. Карточка передачи `.hub/handoffs/<id>.md`, 1. Файловые форматы, 2.1. Агенты и аккаунты (+10 more)

### Community 89 - "cascade.test.ts"
Cohesion: 0.15
Nodes (15): approveVerify(), planVerify(), RunGuard, Rung, cleanup, FAILING_PKG, fake, fakeExe (+7 more)

### Community 90 - "bench.ts"
Cohesion: 0.20
Nodes (12): CLASSES, freshRepo(), GoldenTask, gradeRepo(), loadTasks(), runBench(), runVerify(), fake (+4 more)

### Community 91 - "Db"
Cohesion: 0.18
Nodes (13): LimitSnap, limitSnapshots(), fromDb(), Db, latestLimitMin(), EvalOpts, GateOpts, cnt() (+5 more)

### Community 92 - "cascade-api.test.ts"
Cohesion: 0.14
Nodes (12): api(), capture, db, fake, fakeAgent, fakeExe, pid, review (+4 more)

### Community 93 - "logs.js"
Cohesion: 0.26
Nodes (12): filterOptions(), KIND_RU, kindLabel(), matches(), pid(), filterSelect(), LEVEL, logsPanel() (+4 more)

### Community 94 - "ADR-019: mandatory review gate with verifier votes; only a human approval counts"
Cohesion: 0.14
Nodes (13): ADR-019: mandatory review gate with verifier votes; only a human approval counts, Consequences, Convergence, Data model, Decision, Findings are answered, not ignored, Known limitations (accepted), Trust model (+5 more)

### Community 95 - "trace-model.js"
Cohesion: 0.23
Nodes (13): at(), AGENTS, int(), INVISIBLE, ADR-0012, mergePage(), money(), num() (+5 more)

### Community 96 - "checks.test.ts"
Cohesion: 0.20
Nodes (11): CheckResult, exportCommit(), pathProblem(), safeEntry(), g(), project(), tmp(), withTmp() (+3 more)

### Community 97 - "runCheck"
Cohesion: 0.18
Nodes (14): fail(), gateChecks(), isFile(), killTree(), notFound(), pathOf(), printable(), resolveCommand() (+6 more)

### Community 98 - "phase7-api.test.ts"
Cohesion: 0.16
Nodes (11): agents, click, db, get(), home, pid, post(), raw() (+3 more)

### Community 99 - "Agent Hub v0.2 Implementation Plan"
Cohesion: 0.15
Nodes (12): Agent Hub v0.2 Implementation Plan, Global Constraints, Out of scope for v0.2, Phase 0 — Measure before changing, Phase 6 — Wrap-up, Research basis → decisions, Review Focus, Skills by step (load only the one the step names) (+4 more)

### Community 100 - "risk.ts"
Cohesion: 0.35
Nodes (9): ALWAYS_HIGH, globMatch(), globToRegExp(), isDoc(), outside(), riskTier, SENSITIVE, slash() (+1 more)

### Community 101 - "guard-model.js"
Cohesion: 0.26
Nodes (10): CAP_KEYS, CAP_LABEL, capMap(), EFFORT_RU, fin(), guardModel(), INVISIBLE, KINDS (+2 more)

### Community 102 - "ADR-017: verify-and-escalate cascade"
Cohesion: 0.18
Nodes (10): ADR-017: verify-and-escalate cascade, Caps and stop conditions, Consequences, Decision, Quality evidence (task 3.4), Rungs and what each one receives, State shown in the panel, Trust model (+2 more)

### Community 103 - "readReviewConfig"
Cohesion: 0.31
Nodes (11): approvalFile(), approvals(), approvePlan(), defaultChecks(), isObj(), licenseOf(), planFor(), readJson() (+3 more)

### Community 104 - "phase7-round2-api.test.ts"
Cohesion: 0.22
Nodes (10): agents, call(), click, db, get(), home, pid, post() (+2 more)

### Community 105 - "Phase PR — Mandatory thorough review (a gate, not an option)"
Cohesion: 0.20
Nodes (10): Phase PR — Mandatory thorough review (a gate, not an option), Phase PR review, Task PR.1: Review data model and ADR, Task PR.2: Structured reviewers (hunt + verify), Task PR.3: Filter, tag, pre-existing, Task PR.4: Checks first, security pass, risk tier, Task PR.5: Gate orchestration and convergence, Task PR.6: REVIEW.md and rule drift (+2 more)

### Community 106 - "starter.test.ts"
Cohesion: 0.24
Nodes (8): entry(), fake, github(), Node, ok, one(), SHA, why()

### Community 107 - "trace-review-api.test.ts"
Cohesion: 0.22
Nodes (5): db, home, hubHome, quick, root

### Community 108 - "Workflow (one task, one worktree, test first)"
Cohesion: 0.22
Nodes (9): Definition of done, Graph (graphify) rules, Models and effort policy, Read order for a task (graph first), Skills by situation table, Token discipline, Workflow (one task, one worktree, test first), Stable prefix for prompt cache (+1 more)

### Community 109 - "Phase 3 — Model and effort routing toward the ideal"
Cohesion: 0.22
Nodes (9): Phase 3 — Model and effort routing toward the ideal, Phase 3 review, Task 3.1: (model, effort) pairs as options, Task 3.2: Vendor strengths as tagged priors, Task 3.3: Verify-and-escalate cascade (the user's working principle as a product feature), Task 3.4: Quality from verification, not guesses, Task 3.5: Strategy comparison on the user's own data, Task 3.6: Task type detection (+1 more)

### Community 110 - "start.test.ts"
Cohesion: 0.28
Nodes (8): check(), CHECKER, dirs, PS, ROOT, run(), SCRIPT, tmp()

### Community 111 - "breaker.test.ts"
Cohesion: 0.22
Nodes (6): base, Fact, fake, fakeExe, NOW, web

### Community 112 - "8. Iteration plan"
Cohesion: 0.25
Nodes (8): 8. Iteration plan, Cross-cutting (12 · Opus 2 · Sonnet 10) and reviews (14 · Opus 6 · Sonnet 8), I0 — Bootstrap (6 sessions: Opus 4 · Sonnet 2), I1 — Library & sync (14 · Opus 3 · Sonnet 11), I2 — History & ledger (12 · Opus 2 · Sonnet 10), I3 — Adapters, run, handoff (16 · Opus 5 · Sonnet 11), I4 — Economics & advisor (8 · Opus 2 · Sonnet 6), I5 — Lifecycle & UI (14 · Opus 3 · Sonnet 11)

### Community 113 - "package-check.ts"
Cohesion: 0.32
Nodes (6): checkPackageList(), localUserPathIn(), NEED, NEED_DIRS, PackageVerdict, GOOD

### Community 114 - "Phase 7 — Observability and forecasting"
Cohesion: 0.29
Nodes (7): Phase 7 — Observability and forecasting, Phase 7 review, Task 7.1: Detailed run trace, Task 7.2: Live context gauge, Task 7.3: Project forecast, Task 7.4: Use the leftover limit before reset (opt-in), Task 7.5: Guardrails (circuit breaker)

### Community 115 - "automation/REVIEW.md"
Cohesion: 0.29
Nodes (5): Доказательство: файл и строка, Лимит мелочей: 5, Не проверять, Пути, где нужен человек, Что здесь считается поломкой

### Community 116 - "design-study/REVIEW.md"
Cohesion: 0.29
Nodes (5): Доказательство: файл и строка, Лимит мелочей: 5, Не проверять, Пути, где нужен человек, Что здесь считается поломкой

### Community 117 - "mobile-app/REVIEW.md"
Cohesion: 0.29
Nodes (5): Доказательство: файл и строка, Лимит мелочей: 5, Не проверять, Пути, где нужен человек, Что здесь считается поломкой

### Community 118 - "web-saas/REVIEW.md"
Cohesion: 0.29
Nodes (5): Доказательство: файл и строка, Лимит мелочей: 5, Не проверять, Пути, где нужен человек, Что здесь считается поломкой

### Community 119 - "init.test.ts"
Cohesion: 0.33
Nodes (4): fake, project(), TYPES, world()

### Community 120 - "templates.test.ts"
Cohesion: 0.29
Nodes (4): fake, made, sk, TYPES

### Community 121 - "breaker-round2.test.ts"
Cohesion: 0.29
Nodes (5): base, Fact, fake, fakeExe, NOW

### Community 122 - "integrity.test.ts"
Cohesion: 0.29
Nodes (4): base, HOME, job, NOW

### Community 123 - "{{name}}: архитектура"
Cohesion: 0.29
Nodes (6): {{name}}: архитектура, Границы, Сбои и повторы, Секреты, Триггеры, Шаги

### Community 124 - "{{name}}: архитектура"
Cohesion: 0.29
Nodes (6): {{name}}: архитектура, Варианты, Вопрос и критерии, Проверка, Референсы, Решение

### Community 125 - "{{name}}: архитектура"
Cohesion: 0.29
Nodes (6): {{name}}: архитектура, Выпуск, Данные и офлайн, Доступ к устройству, Подписи и ключи, Экраны и переходы

### Community 126 - "{{name}}: архитектура"
Cohesion: 0.29
Nodes (6): {{name}}: архитектура, Выкладка, Данные, Доступ, Контракты, Секреты и среда

### Community 127 - "chip"
Cohesion: 0.48
Nodes (6): stepsLine(), chip(), cascadeCard(), ADR-0012, stepRow(), outcomeChip()

### Community 128 - "Phase 2 — Chat and history like the real CLIs"
Cohesion: 0.33
Nodes (6): Phase 2 — Chat and history like the real CLIs, Phase 2 review, Task 2.1: Event model v2, Task 2.2: CLI-like transcript renderer, Task 2.3: History rendered from the source files, continuable, Task 2.4: Keep one Claude process per chat (spike, then decide)

### Community 129 - "Phase 4 — Token economy"
Cohesion: 0.33
Nodes (6): Phase 4 review, Phase 4 — Token economy, Task 4.1: Context rules that save tokens (+ the Autopilot rules), Task 4.2: Per-task tool sets (skills, plugins, MCP), Task 4.3: Fresh context at the right size, Task 4.4: Graph as a first-class project tool

### Community 130 - "Phase 5 — Fastest entry: starter kit"
Cohesion: 0.33
Nodes (6): Phase 5 — Fastest entry: starter kit, Phase 5 review, Task 5.1: First-run wizard, Task 5.2: Project templates (architectures), Task 5.3: Shipped work modes wired to installed skills, Task 5.4: One-command start on Windows

### Community 131 - "screen-model.test.ts"
Cohesion: 0.33
Nodes (3): here, model, web

### Community 132 - "{{name}}: бриф"
Cohesion: 0.33
Nodes (5): {{name}}: бриф, Главные сценарии, Границы первой версии, Для кого и зачем, Как поймём, что готово

### Community 133 - "{{name}}: бриф"
Cohesion: 0.33
Nodes (5): {{name}}: бриф, Главные сценарии, Границы первой версии, Для кого и зачем, Как поймём, что готово

### Community 134 - "{{name}}: бриф"
Cohesion: 0.33
Nodes (5): {{name}}: бриф, Главные сценарии, Границы первой версии, Для кого и зачем, Как поймём, что готово

### Community 135 - "{{name}}: бриф"
Cohesion: 0.33
Nodes (5): {{name}}: бриф, Главные сценарии, Границы первой версии, Для кого и зачем, Как поймём, что готово

### Community 136 - "Phase 1 — Modes that really work"
Cohesion: 0.40
Nodes (5): Phase 1 — Modes that really work, Phase 1 review, Task 1.1: Permission presets, applied on start **and** resume, Task 1.2: Live mode probe (`hub doctor --modes`), Task 1.3: Work modes (presets) — Chat, Task, Interview, Autopilot, Review

### Community 137 - "ADR-025: using the leftover limit before a reset is opt-in per project, starts only what the user approved, and fails closed"
Cohesion: 0.40
Nodes (4): ADR-025: using the leftover limit before a reset is opt-in per project, starts only what the user approved, and fails closed, Review fixes (after the Opus review of 7.3-7.5), Second review round, What an unattended agent can reach

### Community 138 - "ADR-026: the circuit breaker stops runaway runs, is ON by default, and only the user's own config can loosen it"
Cohesion: 0.40
Nodes (4): ADR-026: the circuit breaker stops runaway runs, is ON by default, and only the user's own config can loosen it, Review fixes (after the Opus review of 7.3-7.5), Second review round, What an unattended agent can reach

### Community 139 - "Adapter fixtures"
Cohesion: 0.50
Nodes (3): Adapter fixtures, From documentation or memory only (unverified), Shapes seen in local history (observed shape, synthetic content)

## Knowledge Gaps
- **740 isolated node(s):** `hi`, `root`, `dist`, `root`, `themes` (+735 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `h()` connect `h` to `btn`, `transcript.js`, `workmodes.ts`, `context-gauge.js`, `forecast.js`, `review.js`, `autouse.js`, `common.js`, `ui.js`, `project.js`, `gate.test.ts`, `logs.js`, `chip`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Why does `World` connect `gate.test.ts` to `RunManager`, `history/store.ts`, `main.ts`, `security.mjs`, `gate.ts`, `h`, `Db`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `Security and vulnerability checks (SECURITY.md)` connect `Agent Hub (local-first hub for coding agents)` to `Workflow (one task, one worktree, test first)`, `Tooling for building the project (TOOLING.md)`, `adr/README.md`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `h()` (e.g. with `trustedSkillLinked()` and `World`) actually correct?**
  _`h()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `hi`, `root`, `dist` to the rest of the system?**
  _740 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `btn` be split into smaller, more focused modules?**
  _Cohesion score 0.1425339366515837 - nodes in this community are weakly interconnected._
- **Should `transcript.js` be split into smaller, more focused modules?**
  _Cohesion score 0.12692307692307692 - nodes in this community are weakly interconnected._