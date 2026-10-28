# Graph Report - agent-hub  (2026-10-28)

## Corpus Check
- 329 files · ~487,391 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2830 nodes · 7446 edges · 185 communities (158 shown, 27 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 204 edges (avg confidence: 0.78)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3524eb0e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- btn
- transcript.js
- Not verified / known limits
- prompt.md (pinned reconstruction prompt S1)
- Tooling for building the project (TOOLING.md)
- history/store.ts
- loading.ts
- main.ts
- api.ts
- index.ts
- security.mjs
- map.js
- redact
- adapters/types.ts
- build-tokens.mjs
- review.js
- RegistryEntry
- hub.js
- fake-agent.mjs
- CLAUDE.md (pointer to AGENTS.md)
- workmodes.ts
- agents.ts
- server.test.ts
- forecast.ts
- runner.ts
- core.test.ts
- install.test.ts
- hooks-adopt.test.ts
- history/codex.ts
- Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать
- run.test.ts
- core/types.ts
- router.ts
- install-remote.test.ts
- loading.test.ts
- eval.ts
- starter.ts
- workmodes-fixes.test.ts
- context-review.test.ts
- Agent Hub (local-first hub for coding agents)
- ADR-019: mandatory review gate with verifier votes; only a human approval counts
- lean.ts
- Optimization (OPTIMIZATION.md)
- gate.ts
- Models and limits (MODELS-AND-LIMITS.md)
- Orchestrator map, sub-run control and step journal: design
- trace.ts
- registry.ts
- trace.js
- common.js
- checks.ts
- cascade.ts
- project.js
- context.ts
- server.ts
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
- autouse-wire.ts
- context-gauge.js
- auth.ts
- forecast.js
- map-api.ts
- adr/README.md
- strategies.ts
- autouse.js
- git.ts
- phase7-api.ts
- integrity.ts
- priors.ts
- h
- autouse-integration.test.ts
- 2. Схема базы
- cascade.test.ts
- bench.ts
- guardrails.ts
- cascade-api.test.ts
- logs.js
- map.ts
- trace-model.js
- checks.test.ts
- Review Focus
- phase7-api.test.ts
- Agent Hub v0.2 Implementation Plan
- reviewmd.ts
- guard-model.js
- map-api.test.ts
- ADR-017: verify-and-escalate cascade
- phase7-round2-api.test.ts
- Phase PR — Mandatory thorough review (a gate, not an option)
- starter.test.ts
- trace-review-api.test.ts
- Workflow (one task, one worktree, test first)
- Phase 3 — Model and effort routing toward the ideal
- start.test.ts
- breaker.test.ts
- Agent Hub — архитектура
- package-check.ts
- Phase 7 — Observability and forecasting
- Agent Hub — Project Specification & Delivery Plan
- map.test.ts
- trace.test.ts
- AGENTS.md
- init.test.ts
- templates.test.ts
- breaker-round2.test.ts
- integrity.test.ts
- {{name}}: architecture
- {{name}}: architecture
- {{name}}: architecture
- {{name}}: architecture
- chip
- Phase 2 — Chat and history like the real CLIs
- Phase 4 — Token economy
- Phase 5 — Fastest entry: starter kit
- screen-model.test.ts
- {{name}}: brief
- {{name}}: brief
- {{name}}: brief
- {{name}}: brief
- Phase 1 — Modes that really work
- mode-rules-api.test.ts
- Security and vulnerability checks (SECURITY.md)
- Adapter fixtures
- 4. Компоненты
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
- rel
- 8. Iteration plan
- mcp-test.ts
- automation/REVIEW.md
- design-study/REVIEW.md
- mobile-app/REVIEW.md
- web-saas/REVIEW.md
- 1. Product brief (ТЗ)
- 2. Functional requirements
- hooks.ts
- map-native.test.ts
- ADR-025: using the leftover limit before a reset is opt-in per project, starts only what the user approved, and fails closed
- ADR-026: the circuit breaker stops runaway runs, is ON by default, and only the user's own config can loosen it
- 5. Ключевые потоки
- 6. Model routing and call specifications
- ADR-027: the orchestrator map reads what the hub already stores; hub runs can be messaged, native sub-agents cannot; steps go to a journal; modes teach rules
- Pipelines: short review (2026-10-28)
- 5. Principles
- ADR-018: a task run past 250K tokens of context is stopped and continued in a fresh session from its handoff card
- ADR-020: a run starts only the skills and MCP servers its work mode needs
- ADR-021: the project graph is built by a bounded `graphify update` the user starts
- ADR-022: the starter kit installs third-party skills into the hub library only, from named repositories, at a pinned commit, after the user was shown every byte
- ADR-023: `hub new` creates a project only in a new or empty folder, and its verify command stays unapproved
- ADR-024: the run trace and the context gauge read `turn` rows the hub stores per model call: numbers, names and times only, bounded everywhere

## God Nodes (most connected - your core abstractions)
1. `h()` - 144 edges
2. `redact()` - 61 edges
3. `btn()` - 60 edges
4. `AgentId` - 57 edges
5. `chip()` - 56 edges
6. `RunManager` - 49 edges
7. `icon()` - 44 edges
8. `main()` - 41 edges
9. `toast()` - 41 edges
10. `runRound()` - 40 edges

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

## Communities (185 total, 27 thin omitted)

### Community 0 - "btn"
Cohesion: 0.17
Nodes (37): n(), btn(), closeBtn(), copy(), dialog(), field(), pills(), toast() (+29 more)

### Community 1 - "transcript.js"
Cohesion: 0.12
Nodes (38): argFor(), bodyView(), corner(), diffLine(), diffRow(), duration(), errRes(), FAMILY (+30 more)

### Community 2 - "Not verified / known limits"
Cohesion: 0.14
Nodes (20): ADR-015: prompt goes through stdin, never arguments, Claude rate_limit_event shape never seen, Real Codex rate_limits snapshot (94 percent of weekly window), Codex success path unverified, Docker scanners not run (gitleaks, semgrep, trivy), Needs your decision, Not done: FR-R6 hub open agent, Not verified / known limits (+12 more)

### Community 3 - "prompt.md (pinned reconstruction prompt S1)"
Cohesion: 0.07
Nodes (50): tokens.css / tokens.json (generated), preview.html (live board of four themes), cardSheet (handoff card dialog), app click/change event handlers, compat / compatCell, decision (T016 decision card), diffSheet (changes-to-write dialog), dock (mobile bottom glass dock) (+42 more)

### Community 4 - "Tooling for building the project (TOOLING.md)"
Cohesion: 0.14
Nodes (21): Agent Hub Design System v0.1, Accent edge (light themes), Accent fill vs accent text rule, First component set (limit meter, handoff card, stage stepper, approval diff sheet), Measured contrast table, Material: opaque work surfaces, glass only for navigation, shadcn/ui variable bridge, Typography (Golos Text, JetBrains Mono) (+13 more)

### Community 5 - "history/store.ts"
Cohesion: 0.06
Nodes (41): db, t, claudeWindowMinutes(), LimitSnap, limitSnapshots(), fromDb(), job, NOW (+33 more)

### Community 6 - "loading.ts"
Cohesion: 0.14
Nodes (19): auditLoading(), CLAUDE_FILE, ClaudeLocal, CodexBlock, compileProfile(), Desired, LoadingAudit, mcpNamesClaude() (+11 more)

### Community 7 - "main.ts"
Cohesion: 0.20
Nodes (35): authStatus(), detectAgents(), Args, BOOL, cmdBench(), cmdConfig(), cmdGet(), cmdHooks() (+27 more)

### Community 8 - "api.ts"
Cohesion: 0.05
Nodes (37): openLogin(), PICK_PS, pickFolder(), skillRoots(), Overhead, q(), startOverhead(), createSkillsEstimator() (+29 more)

### Community 9 - "index.ts"
Cohesion: 0.15
Nodes (25): REPO_ROOT, ARCH, archDoc(), box(), build(), check(), dataDoc(), Doc (+17 more)

### Community 10 - "security.mjs"
Cohesion: 0.12
Nodes (17): all, code, dir, failed, files(), hits, inline, inner (+9 more)

### Community 11 - "map.js"
Cohesion: 0.12
Nodes (25): w(), changedToDone(), contextPct(), ADR-0027, KIND_RU, kindLabel(), layout(), REASON_RU (+17 more)

### Community 12 - "redact"
Cohesion: 0.12
Nodes (31): Block, brief(), ClaudeLine, parseLine(), resultText(), ADR-0024, CodexLine, Item (+23 more)

### Community 13 - "adapters/types.ts"
Cohesion: 0.10
Nodes (24): fake, run(), ADR-0024, withFake(), claudeAdapter, codexAdapter, dir, feed() (+16 more)

### Community 14 - "build-tokens.mjs"
Cohesion: 0.29
Nodes (6): bridge, css, root, sel, shared, themes

### Community 15 - "review.js"
Cohesion: 0.06
Nodes (62): api(), db, fakeAgent, fakeExe, home, hubHome, raw(), root (+54 more)

### Community 16 - "RegistryEntry"
Cohesion: 0.16
Nodes (14): Candidate, AitmplItem, defaultFetcher(), fetchAitmpl(), Fetcher, GhRunner, risk(), searchGithub() (+6 more)

### Community 17 - "hub.js"
Cohesion: 0.50
Nodes (3): dist, hi, root

### Community 22 - "workmodes.ts"
Cohesion: 0.15
Nodes (19): AGENTS, AP_DEPTHS, AP_MODES, ApplyOpts, applyWorkMode(), autopilotFix(), CLASSES, defaultHubRoots() (+11 more)

### Community 23 - "agents.ts"
Cohesion: 0.07
Nodes (46): ADR-0010, Pick, reviewersDir(), block(), buildHuntPrompt(), buildVerifyPrompt(), Common, ctx() (+38 more)

### Community 24 - "server.test.ts"
Cohesion: 0.12
Nodes (13): api(), db, fake, fakeAgent, fakeExe, graphCtx, runs, scenario (+5 more)

### Community 25 - "forecast.ts"
Cohesion: 0.08
Nodes (38): Classified, classify(), COMPILED, RULES, cls(), Calib, OutcomeRow, AGENT_RU (+30 more)

### Community 26 - "runner.ts"
Cohesion: 0.06
Nodes (48): Capability, classify(), Ev, IS_TOOL, loadMatrix(), ModeMatrix, probeModes(), repo() (+40 more)

### Community 27 - "core.test.ts"
Cohesion: 0.18
Nodes (3): fake, gtmp, ADR-0021

### Community 30 - "history/codex.ts"
Cohesion: 0.11
Nodes (39): sanitizeEvent(), Block, clip(), historyLineEvents(), isNoise(), Line, readSessionEvents(), syncClaude() (+31 more)

### Community 31 - "Agent Hub v0.1 — отчёт: что сделано, как работает, как запускать"
Cohesion: 0.11
Nodes (18): 1. Адаптировано ли использование токенов, 1. Главный вывод про токены, 2. Выбор модели: не правило, а ближайшая точка к идеалу, 2. Как устроена «инструменты только под проект», 3. Как это выглядит в панели, 3. Сбор данных пользователей с согласия, 4. Как запустить, 5. Аудит качества: что нашёл и исправил (+10 more)

### Community 32 - "run.test.ts"
Cohesion: 0.13
Nodes (21): approvalFile(), approvals(), approveRunnerHooks(), argvList(), digest(), empty(), HookResult, readRunnerHooks() (+13 more)

### Community 33 - "core/types.ts"
Cohesion: 0.11
Nodes (38): compileAll(), compileMcpClaude(), compileMcpCodex(), compileRules(), compileSkill(), McpJson, mcpName(), projectType() (+30 more)

### Community 34 - "router.ts"
Cohesion: 0.10
Nodes (32): advise(), AdviseIn, Choice, EFFORT_RU, EXPLORABLE, FAMILY_RU, full(), GPT_EFFORT (+24 more)

### Community 35 - "install-remote.test.ts"
Cohesion: 0.67
Nodes (3): catalog(), fake, fetcher()

### Community 36 - "loading.test.ts"
Cohesion: 0.67
Nodes (3): fake, mk(), skill()

### Community 37 - "eval.ts"
Cohesion: 0.09
Nodes (43): cmdReviewEval(), verifyMany(), answerCounts(), ANSWERS, BLOCKING, caseFromFinding(), CaseResult, caseSummary (+35 more)

### Community 38 - "starter.ts"
Cohesion: 0.09
Nodes (38): defaultTextFetcher, makeTextFetcher(), planLibraryInstall(), Preview, previewComponent(), RawItem, relOk(), slug() (+30 more)

### Community 39 - "workmodes-fixes.test.ts"
Cohesion: 0.14
Nodes (11): bases, mode(), noLib, loadWorkModes(), ModeReviewer, pickModeReviewer(), mode(), noLib (+3 more)

### Community 40 - "context-review.test.ts"
Cohesion: 0.15
Nodes (11): file, g, handoffMode(), hubOwnsFolder(), answer, base, clock(), mk() (+3 more)

### Community 41 - "Agent Hub (local-first hub for coding agents)"
Cohesion: 0.14
Nodes (14): Mission: local-first hub unifying agents, Repository map, UI rules (tokens, four themes, sizes), Real history import: 18 s first run, 0.0 s re-sync, Panel verified in Chrome (4 themes, desktop and 390 px), Untested platforms and accessibility, Agent Hub (local-first hub for coding agents), Unified read-only history index (+6 more)

### Community 42 - "ADR-019: mandatory review gate with verifier votes; only a human approval counts"
Cohesion: 0.14
Nodes (13): ADR-019: mandatory review gate with verifier votes; only a human approval counts, Consequences, Convergence, Data model, Decision, Findings are answered, not ignored, Known limitations (accepted), Trust model (+5 more)

### Community 43 - "lean.ts"
Cohesion: 0.16
Nodes (17): loadCatalog(), readCatalogDir(), shippedCatalogIds(), WorkMode, canon(), canonDeep(), inside(), launcher() (+9 more)

### Community 44 - "Optimization (OPTIMIZATION.md)"
Cohesion: 0.19
Nodes (13): Eleven practices to keep spend low, Optimization (OPTIMIZATION.md), Golden task set eval/golden, harness2 mechanisms adopted (probes, lessons, golden eval), Hypotheses to test first, Lessons with evidence (.hub/lessons), Three memory types (semantic, episodic, procedural), Two-level skills (profile of 15 + hub-skill-index) (+5 more)

### Community 45 - "gate.ts"
Cohesion: 0.07
Nodes (62): diffTooLarge(), approveChecks(), gateChecks(), notApprovedReason(), planChecks(), readReviewConfig(), answer(), approve() (+54 more)

### Community 46 - "Models and limits (MODELS-AND-LIMITS.md)"
Cohesion: 0.24
Nodes (11): Models and limits (MODELS-AND-LIMITS.md), Two-week calibration plan, Claude API pricing table, Codex as fallback when Claude Pro limit is hit, Codex log findings (97.9 percent cache, 57 percent subagent tokens), Escalation ladder and triggers, Weekly limit percent cannot be derived by formula, Model allocation (Opus 27 sessions, Sonnet 69) (+3 more)

### Community 47 - "Orchestrator map, sub-run control and step journal: design"
Cohesion: 0.14
Nodes (13): Constraints that come from the code (observed), English-only agent-facing text, Goals, Intent and why, Non-goals and anti-goals, Open questions for the user, Orchestrator map, sub-run control and step journal: design, Stages (+5 more)

### Community 48 - "trace.ts"
Cohesion: 0.15
Nodes (17): buildTrace(), cachedTrace(), obj(), Pending, readTraceEvents(), at(), fake, seeded() (+9 more)

### Community 49 - "registry.ts"
Cohesion: 0.13
Nodes (27): ApplyResult, home(), listPlugins(), PluginInfo, skillCost(), suggest(), scanLocalSkills(), skillDirs() (+19 more)

### Community 50 - "trace.js"
Cohesion: 0.27
Nodes (11): lanes(), msText(), fmt, cell(), ADR-0012, OUTCOME_RU, pct(), stat() (+3 more)

### Community 51 - "common.js"
Cohesion: 0.11
Nodes (30): api, call(), prefs, stream(), stepsLine(), renderRun(), renderSafe(), agentName() (+22 more)

### Community 52 - "checks.ts"
Cohesion: 0.07
Nodes (52): AddedDep, addedDependencies(), approvalFile(), approvals(), approvePlan(), buildPlan(), CheckOpts, CopyError (+44 more)

### Community 53 - "cascade.ts"
Cohesion: 0.12
Nodes (33): run(), CheckPlan, block(), CascadeOpts, CascadeResult, CascadeState, clip(), dataRule() (+25 more)

### Community 54 - "project.js"
Cohesion: 0.13
Nodes (27): sectionHead(), svgEl(), modelName(), pctText(), shortModel(), TASKS, BALANCE, dateRu() (+19 more)

### Community 55 - "context.ts"
Cohesion: 0.13
Nodes (20): ADR-0014, Breakdown, Cache, cacheState(), contextBreakdown(), contextLevel(), ctxOf(), Handoff (+12 more)

### Community 56 - "server.ts"
Cohesion: 0.23
Nodes (13): q(), sweepReviewerDirs(), sweepCheckRuns(), apiOf(), markInterruptedReviews(), handle(), cookieOf(), eqToken() (+5 more)

### Community 57 - "econ.ts"
Cohesion: 0.12
Nodes (36): bucket(), buildCases(), bundle(), Case, exportCases(), installId(), isoWeek(), NEVER_INCLUDED (+28 more)

### Community 58 - "review/store.ts"
Cohesion: 0.13
Nodes (28): EvalResult, reviewsOfRun(), addFindings(), answerFinding(), clearHumanApproval(), createReview(), FindingRow, listFindings() (+20 more)

### Community 59 - "prices.ts"
Cohesion: 0.15
Nodes (25): PRICES_VERIFIED_AT, badId(), bundledCheckedAt(), DEFAULT_PRICES_PATH, isObj(), loadPriceTable(), money(), NONE (+17 more)

### Community 60 - "review/types.ts"
Cohesion: 0.16
Nodes (19): sha256(), fnd(), clip(), count(), DiffLine, DROPPED, fold(), indexDiff() (+11 more)

### Community 61 - "breaker.ts"
Cohesion: 0.13
Nodes (31): ackFile(), ackTrip(), auditGuard(), blockingTrips(), CAP_RANGE, Caps, capsProblem(), chainDepth() (+23 more)

### Community 62 - "autouse.ts"
Cohesion: 0.10
Nodes (36): approveItem(), AutoDeps, AutoItem, AutoProject, AutoScheduler, AutoState, cancelItem(), clip() (+28 more)

### Community 63 - "greet.js"
Cohesion: 0.60
Nodes (3): greet(), getUsr(), users

### Community 71 - "autouse-wire.ts"
Cohesion: 0.19
Nodes (24): acquireLock(), body(), file(), heartbeat(), holdsLock(), Lock, LockDeps, lockStatus (+16 more)

### Community 75 - "context-gauge.js"
Cohesion: 0.14
Nodes (23): AGENTS, cacheLine(), contextModel(), gaugeText(), HANDOFFS, INVISIBLE, ADR-0018, levelChip() (+15 more)

### Community 76 - "auth.ts"
Cohesion: 0.20
Nodes (11): AuthInfo, cache, forgetAuth(), parseAuth(), Runner, RunnerIn, AgentInfo, codexFromAppData() (+3 more)

### Community 77 - "forecast.js"
Cohesion: 0.17
Nodes (23): AGENT_RU, AGENTS, BASES, basisText(), forecastLine(), forecastModel(), INVISIBLE, LABELS (+15 more)

### Community 78 - "map-api.ts"
Cohesion: 0.14
Nodes (20): isSafeName(), appendStep(), fileOf(), JournalEntry, KINDS, line(), names(), planJournalWrite() (+12 more)

### Community 79 - "adr/README.md"
Cohesion: 0.35
Nodes (10): Code conventions (single package, erasable TS, JSON, Windows first), ADR-010: one package, zero runtime dependencies, ADR-011: JSON file formats instead of YAML, ADR-012: panel is plain ES modules, no React, no bundler, ADR-013: TypeScript via Node type stripping, tsc build for publishing, ADR-001…009: no separate files, ADR-010…027, ADR index (+2 more)

### Community 80 - "strategies.ts"
Cohesion: 0.13
Nodes (20): surchargeFor(), priceTier(), rank(), cascade(), Cell, CLASSES, compareStrategies(), fromBench() (+12 more)

### Community 81 - "autouse.js"
Cohesion: 0.19
Nodes (21): AGENTS, agentText(), autoModel(), confirmMatches(), fin(), hoursText(), INVISIBLE, KIND_RU (+13 more)

### Community 82 - "git.ts"
Cohesion: 0.10
Nodes (36): killTree(), ALWAYS_SKIP, envPath(), globSeg(), GRAPHIGNORE, GraphLast, GraphState, graphStatus (+28 more)

### Community 83 - "phase7-api.ts"
Cohesion: 0.08
Nodes (34): authStatusIn(), confirmWordFor(), isEnabled(), AGENTS, BILLING_ENV, billingOk(), eligibility(), exists() (+26 more)

### Community 84 - "integrity.ts"
Cohesion: 0.17
Nodes (26): addSkillRoot(), loadUserConfig(), removeSkillRoot(), saveUserConfig(), userCapsRaw(), auditName(), canon(), fileState() (+18 more)

### Community 85 - "priors.ts"
Cohesion: 0.16
Nodes (18): basisOf(), CLASSES, common(), DEFAULT_PRIORS_PATH, isObj(), isoDate(), loadPriors(), MODELS (+10 more)

### Community 86 - "h"
Cohesion: 0.14
Nodes (36): app, main, NAV, navKey(), navLink(), quickSearch(), route(), ROUTES (+28 more)

### Community 87 - "autouse-integration.test.ts"
Cohesion: 0.29
Nodes (6): base, fake, fakeExe, home, repo, waitEnd()

### Community 88 - "2. Схема базы"
Cohesion: 0.11
Nodes (18): 1.1. `hub.yaml` — проект, 1.2. `toolkit.yaml` — выбранные инструменты проекта (этап 3), 1.3. `hub.lock` — воспроизводимая установка, 1.4. Запись реестра `registry/entries/<kind>/<name>.yaml`, 1.5. Этап `stages/<name>.yaml`, 1.6. Карточка передачи `.hub/handoffs/<id>.md`, 1. Файловые форматы, 2.1. Агенты и аккаунты (+10 more)

### Community 89 - "cascade.test.ts"
Cohesion: 0.15
Nodes (16): approveVerify(), planVerify(), Rung, cleanup, FAILING_PKG, fake, fakeExe, gitc() (+8 more)

### Community 90 - "bench.ts"
Cohesion: 0.12
Nodes (21): BenchOpts, BenchRow, CLASSES, freshRepo(), GoldenTask, gradeRepo(), loadTasks(), parsePicks() (+13 more)

### Community 91 - "guardrails.ts"
Cohesion: 0.39
Nodes (6): Baseline, Scores, cnt(), guardrails, reviewWindow, Effort

### Community 92 - "cascade-api.test.ts"
Cohesion: 0.11
Nodes (14): api(), capture, db, fake, fakeAgent, fakeExe, pid, review (+6 more)

### Community 93 - "logs.js"
Cohesion: 0.26
Nodes (12): filterOptions(), KIND_RU, kindLabel(), matches(), pid(), filterSelect(), LEVEL, logsPanel() (+4 more)

### Community 94 - "map.ts"
Cohesion: 0.21
Nodes (13): buildFullMap(), buildMap(), extractNative(), handoffReason(), MapEdge, MapNode, NodeKind, one() (+5 more)

### Community 95 - "trace-model.js"
Cohesion: 0.24
Nodes (13): AGENTS, int(), INVISIBLE, ADR-0012, mergePage(), money(), num(), obj() (+5 more)

### Community 96 - "checks.test.ts"
Cohesion: 0.21
Nodes (9): CheckResult, exportCommit(), pathProblem(), safeEntry(), g(), project(), tmp(), withTmp() (+1 more)

### Community 97 - "Review Focus"
Cohesion: 0.15
Nodes (12): Global Constraints, Orchestrator Map (Stage 1) Implementation Plan, Review Focus, Self-review, Task A: English-only agent-facing text, Task B: Rules by mode, Task C: Map tree builder, Task D: Native sub-agents and background processes (+4 more)

### Community 98 - "phase7-api.test.ts"
Cohesion: 0.16
Nodes (11): agents, click, db, get(), home, pid, post(), raw() (+3 more)

### Community 99 - "Agent Hub v0.2 Implementation Plan"
Cohesion: 0.15
Nodes (12): Agent Hub v0.2 Implementation Plan, Global Constraints, Out of scope for v0.2, Phase 0 — Measure before changing, Phase 6 — Wrap-up, Research basis → decisions, Review Focus, Skills by step (load only the one the step names) (+4 more)

### Community 100 - "reviewmd.ts"
Cohesion: 0.11
Nodes (29): appendRuleChange(), esc(), headingRe(), humanPathsForChanges(), humanPathsFromReviewMd(), inside(), LEGACY_HEADINGS, loadReviewMd() (+21 more)

### Community 101 - "guard-model.js"
Cohesion: 0.26
Nodes (10): CAP_KEYS, CAP_LABEL, capMap(), EFFORT_RU, fin(), guardModel(), INVISIBLE, KINDS (+2 more)

### Community 102 - "map-api.test.ts"
Cohesion: 0.15
Nodes (8): db, fake, fakeAgent, fakeExe, Init, pid, root, runs

### Community 103 - "ADR-017: verify-and-escalate cascade"
Cohesion: 0.18
Nodes (10): ADR-017: verify-and-escalate cascade, Caps and stop conditions, Consequences, Decision, Quality evidence (task 3.4), Rungs and what each one receives, State shown in the panel, Trust model (+2 more)

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
Cohesion: 0.25
Nodes (8): Definition of done, Graph (graphify) rules, Models and effort policy, Read order for a task (graph first), Skills by situation table, Token discipline, Workflow (one task, one worktree, test first), Development commands (test, typecheck, security, build, tokens)

### Community 109 - "Phase 3 — Model and effort routing toward the ideal"
Cohesion: 0.22
Nodes (9): Phase 3 — Model and effort routing toward the ideal, Phase 3 review, Task 3.1: (model, effort) pairs as options, Task 3.2: Vendor strengths as tagged priors, Task 3.3: Verify-and-escalate cascade (the user's working principle as a product feature), Task 3.4: Quality from verification, not guesses, Task 3.5: Strategy comparison on the user's own data, Task 3.6: Task type detection (+1 more)

### Community 110 - "start.test.ts"
Cohesion: 0.28
Nodes (8): check(), CHECKER, dirs, PS, ROOT, run(), SCRIPT, tmp()

### Community 111 - "breaker.test.ts"
Cohesion: 0.22
Nodes (6): base, Fact, fake, fakeExe, NOW, web

### Community 112 - "Agent Hub — архитектура"
Cohesion: 0.18
Nodes (11): 10. Технологический выбор (кратко, решения), 11. Порядок сборки, 12. Что не проверено и риски, 1. Зачем это нужно, 2. Цели, не-цели, анти-цели, 3. Принципы, 6. Совместимость и адаптация компонентов, 7. Модель безопасности (+3 more)

### Community 113 - "package-check.ts"
Cohesion: 0.32
Nodes (6): checkPackageList(), localUserPathIn(), NEED, NEED_DIRS, PackageVerdict, GOOD

### Community 114 - "Phase 7 — Observability and forecasting"
Cohesion: 0.29
Nodes (7): Phase 7 — Observability and forecasting, Phase 7 review, Task 7.1: Detailed run trace, Task 7.2: Live context gauge, Task 7.3: Project forecast, Task 7.4: Use the leftover limit before reset (opt-in), Task 7.5: Guardrails (circuit breaker)

### Community 115 - "Agent Hub — Project Specification & Delivery Plan"
Cohesion: 0.18
Nodes (9): 0. Document map, 10. Definition of Done (every task), 11. Risks and open questions, 12. Decisions so far (by the author), 3. Non-functional requirements, 4. Architecture and data model (summary), 7. Skills, plugins and MCP for building, 9. Unit economics (summary) (+1 more)

### Community 116 - "map.test.ts"
Cohesion: 0.20
Nodes (7): db, home, P, Q, R, run(), turn()

### Community 117 - "trace.test.ts"
Cohesion: 0.25
Nodes (10): pageTurns(), at(), claude(), ev(), fake, fakeExe, T0, turn() (+2 more)

### Community 118 - "AGENTS.md"
Cohesion: 0.20
Nodes (9): AGENTS.md, Definition of done, Hard rules, How to work, by kind of task, Models and effort, Save tokens, Skills by situation (use if installed), Start here (+1 more)

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

### Community 123 - "{{name}}: architecture"
Cohesion: 0.29
Nodes (6): Failures and retries, Limits, {{name}}: architecture, Secrets, Steps, Triggers

### Community 124 - "{{name}}: architecture"
Cohesion: 0.29
Nodes (6): Check, Decision, {{name}}: architecture, Options, Question and criteria, References

### Community 125 - "{{name}}: architecture"
Cohesion: 0.29
Nodes (6): Data and offline, Device access, {{name}}: architecture, Release, Screens and transitions, Signing and keys

### Community 126 - "{{name}}: architecture"
Cohesion: 0.29
Nodes (6): Access, Contracts, Data, {{name}}: architecture, Release, Secrets and environment

### Community 127 - "chip"
Cohesion: 0.21
Nodes (20): label(), qs(), chip(), linkProject(), planDialog(), detail(), KIND, view() (+12 more)

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

### Community 132 - "{{name}}: brief"
Cohesion: 0.33
Nodes (5): How we know it is done, Limits of the first version, Main scenarios, {{name}}: brief, Who it is for and why

### Community 133 - "{{name}}: brief"
Cohesion: 0.33
Nodes (5): How we know it is done, Limits of the first version, Main scenarios, {{name}}: brief, Who it is for and why

### Community 134 - "{{name}}: brief"
Cohesion: 0.33
Nodes (5): How we know it is done, Limits of the first version, Main scenarios, {{name}}: brief, Who it is for and why

### Community 135 - "{{name}}: brief"
Cohesion: 0.33
Nodes (5): How we know it is done, Limits of the first version, Main scenarios, {{name}}: brief, Who it is for and why

### Community 136 - "Phase 1 — Modes that really work"
Cohesion: 0.40
Nodes (5): Phase 1 — Modes that really work, Phase 1 review, Task 1.1: Permission presets, applied on start **and** resume, Task 1.2: Live mode probe (`hub doctor --modes`), Task 1.3: Work modes (presets) — Chat, Task, Interview, Autopilot, Review

### Community 137 - "mode-rules-api.test.ts"
Cohesion: 0.20
Nodes (7): db, fake, fakeAgent, fakeExe, pid, root, runs

### Community 138 - "Security and vulnerability checks (SECURITY.md)"
Cohesion: 0.36
Nodes (9): ADR-014: hub commits only on hub/* branches, Hard rules (credentials, read-only stores, no push), Security and vulnerability checks (SECURITY.md), Third-party component risk assessment, Security merge gates, Security scanners (gitleaks, semgrep, osv-scanner, trivy via Docker), Threat model T1 to T10, Push guard (blocking hook via environment) (+1 more)

### Community 139 - "Adapter fixtures"
Cohesion: 0.50
Nodes (3): Adapter fixtures, From documentation or memory only (unverified), Shapes seen in local history (observed shape, synthetic content)

### Community 140 - "4. Компоненты"
Cohesion: 0.22
Nodes (9): 4.1. Ядро (`packages/core`), 4.2. Адаптеры (`packages/adapter-*`), 4.3. Сервер и интерфейс, 4.4. Структура репозитория, 4.5. `hub` как общий CLI для всех нейросетей, 4.6. MCP и библиотеки (в том числе для дизайна), 4.7. Скаут скиллов («постоянный поиск»), 4.8. Политика субагентов (+1 more)

### Community 155 - "rel"
Cohesion: 0.28
Nodes (7): json(), offenders(), rel(), ROOT, strings(), safeRel(), treeReader()

### Community 156 - "8. Iteration plan"
Cohesion: 0.25
Nodes (8): 8. Iteration plan, Cross-cutting (12 · Opus 2 · Sonnet 10) and reviews (14 · Opus 6 · Sonnet 8), I0 — Bootstrap (6 sessions: Opus 4 · Sonnet 2), I1 — Library & sync (14 · Opus 3 · Sonnet 11), I2 — History & ledger (12 · Opus 2 · Sonnet 10), I3 — Adapters, run, handoff (16 · Opus 5 · Sonnet 11), I4 — Economics & advisor (8 · Opus 2 · Sonnet 6), I5 — Lifecycle & UI (14 · Opus 3 · Sonnet 11)

### Community 157 - "mcp-test.ts"
Cohesion: 0.36
Nodes (6): ProbeResult, probeStdio(), Server, dir, fakeServer, testProject()

### Community 158 - "automation/REVIEW.md"
Cohesion: 0.29
Nodes (5): Do not check, Evidence: file and line, Nit limit: 5, Paths that need a human, What counts as broken here

### Community 159 - "design-study/REVIEW.md"
Cohesion: 0.29
Nodes (5): Do not check, Evidence: file and line, Nit limit: 5, Paths that need a human, What counts as broken here

### Community 160 - "mobile-app/REVIEW.md"
Cohesion: 0.29
Nodes (5): Do not check, Evidence: file and line, Nit limit: 5, Paths that need a human, What counts as broken here

### Community 161 - "web-saas/REVIEW.md"
Cohesion: 0.29
Nodes (5): Do not check, Evidence: file and line, Nit limit: 5, Paths that need a human, What counts as broken here

### Community 162 - "1. Product brief (ТЗ)"
Cohesion: 0.33
Nodes (6): 1.1 Problem, 1.2 Product, 1.3 Users, 1.4 Goals / non-goals / anti-goals, 1.5 Scope v1 (MVP), 1. Product brief (ТЗ)

### Community 163 - "2. Functional requirements"
Cohesion: 0.33
Nodes (6): 2. Functional requirements, Economics & advisor (Part 4), History & ledger (Part 2), Library & sync (Part 1), Lifecycle & UI (Part 5), Run, adapters & handoff (Part 3)

### Community 164 - "hooks.ts"
Cohesion: 0.47
Nodes (5): classifyHooks(), ClaudeHooks, CODEX_KNOWN_EVENTS, HookReport, Compat

### Community 165 - "map-native.test.ts"
Cohesion: 0.47
Nodes (4): ev(), result(), tool(), ADR-0027

### Community 166 - "ADR-025: using the leftover limit before a reset is opt-in per project, starts only what the user approved, and fails closed"
Cohesion: 0.40
Nodes (4): ADR-025: using the leftover limit before a reset is opt-in per project, starts only what the user approved, and fails closed, Review fixes (after the Opus review of 7.3-7.5), Second review round, What an unattended agent can reach

### Community 167 - "ADR-026: the circuit breaker stops runaway runs, is ON by default, and only the user's own config can loosen it"
Cohesion: 0.40
Nodes (4): ADR-026: the circuit breaker stops runaway runs, is ON by default, and only the user's own config can loosen it, Review fixes (after the Opus review of 7.3-7.5), Second review round, What an unattended agent can reach

### Community 168 - "5. Ключевые потоки"
Cohesion: 0.40
Nodes (5): 5. Ключевые потоки, A. Подготовка проекта (`hub init` и этап 3), B. Запуск задачи, C. Остановка по лимиту и передача, D. Оценка плана (этап 6)

### Community 169 - "6. Model routing and call specifications"
Cohesion: 0.40
Nodes (5): 6.1 Call types, 6.2 Effort policy, 6.3 Escalation ladder, 6.4 Subagent policy, 6. Model routing and call specifications

### Community 170 - "ADR-027: the orchestrator map reads what the hub already stores; hub runs can be messaged, native sub-agents cannot; steps go to a journal; modes teach rules"
Cohesion: 0.40
Nodes (4): ADR-027: the orchestrator map reads what the hub already stores; hub runs can be messaged, native sub-agents cannot; steps go to a journal; modes teach rules, Consequences, Decisions, Not done in Stage 1

### Community 171 - "Pipelines: short review (2026-10-28)"
Cohesion: 0.50
Nodes (3): Findings, Modes and "training" (what exists), Pipelines: short review (2026-10-28)

### Community 172 - "5. Principles"
Cohesion: 0.67
Nodes (3): 5.1 Product principles, 5.2 How agents build this project, 5. Principles

## Knowledge Gaps
- **820 isolated node(s):** `hi`, `root`, `dist`, `root`, `themes` (+815 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `h()` connect `h` to `btn`, `transcript.js`, `map.js`, `context-gauge.js`, `gate.ts`, `forecast.js`, `review.js`, `autouse.js`, `trace.js`, `common.js`, `workmodes.ts`, `project.js`, `logs.js`, `trace-model.js`, `chip`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `World` connect `gate.ts` to `history/store.ts`, `main.ts`, `security.mjs`, `h`, `runner.ts`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `runCascade()` connect `cascade.ts` to `checks.test.ts`, `cascade.test.ts`, `transcript.js`, `api.ts`, `starter.test.ts`, `gate.ts`, `git.ts`, `checks.ts`, `h`, `forecast.ts`, `runner.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `h()` (e.g. with `trustedSkillLinked()` and `World`) actually correct?**
  _`h()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `hi`, `root`, `dist` to the rest of the system?**
  _820 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `transcript.js` be split into smaller, more focused modules?**
  _Cohesion score 0.12307692307692308 - nodes in this community are weakly interconnected._
- **Should `Not verified / known limits` be split into smaller, more focused modules?**
  _Cohesion score 0.1368421052631579 - nodes in this community are weakly interconnected._