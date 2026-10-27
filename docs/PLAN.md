# Agent Hub — Project Specification & Delivery Plan

> Status: **v0.4**, 2026-10-22. Approved by the author; v0.1.0 implements parts 1–5 locally. What is done, partial and unverified: [STATUS.md](STATUS.md). Deviations: [adr/](adr/).
> Working name `agent-hub` (temporary).

## 0. Document map

| Document | What it holds |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | components, flows, CLI surface, compatibility, security model, ADRs (RU) |
| [DATA-MODEL.md](DATA-MODEL.md) | file formats (`hub.yaml`, `hub.lock`, registry entry, stage, handoff card) and SQLite schema (RU) |
| [SCHEMES.md](SCHEMES.md) | one-page diagrams; also printed by `hub diagram` (RU) |
| [TOOLING.md](TOOLING.md) | skills, plugins, MCP used to build the project (RU) |
| [MODELS-AND-LIMITS.md](MODELS-AND-LIMITS.md) | model routing, effort, measured token profile, limit scenarios (RU) |
| [SECURITY.md](SECURITY.md) | threat model T1–T10, vulnerability gates (RU) |
| [OPTIMIZATION.md](OPTIMIZATION.md) | token, quality, memory, speed and selection optimizations; harness2 insights (RU) |
| [MCP-SETUP.md](MCP-SETUP.md) | connecting Mobbin and shadcn MCP (RU) |
| [../design/DESIGN-SYSTEM.md](../design/DESIGN-SYSTEM.md) | design system: 4 themes (dark/light × green/orange) |
| [../AGENTS.md](../AGENTS.md) | rules every coding agent follows inside this repo |

---

## 1. Product brief (ТЗ)

### 1.1 Problem

A developer works on one project with several coding agents (Claude Code, Codex, others). Today:

- rules, skills, plugins and MCP servers are configured separately per agent and drift apart;
- when one agent hits its usage limit, the next agent knows nothing and the developer re-explains everything;
- there is no single view of cost, limits, model choice or session history across agents.

### 1.2 Product

A local-first **hub** (CLI + localhost web panel) that:

1. keeps **one library** of skills, plugins, MCP servers and rules and compiles them into each agent's native format, with user approval;
2. guides a project through **8 fixed lifecycle stages** with pre-attached skills and gates;
3. **runs any agent** on a task in an isolated git worktree and **hands work over** to another agent when limits run out, using a handoff card instead of re-explaining;
4. computes **unit economics**: tokens, API-equivalent dollars, share of weekly limit, and advises model + reasoning effort per task;
5. shows **unified session history** of all agents;
6. is publishable on GitHub: install with one command, extend with packs.

### 1.3 Users

- Primary: the author (Windows 11, Claude Pro + Codex ProLite, heavy agent user).
- Secondary: other developers who install the hub from GitHub and add their own agents and packs.

### 1.4 Goals / non-goals / anti-goals

| Goals | Non-goals (v1) | Anti-goals (failure even if it "works") |
|---|---|---|
| Same skills and rules visible to Claude and Codex | Merging agents' storage | Silent writes to any agent config, hook or rule |
| Handoff without re-explaining | Shared live context between agents | Secret leaked to index, log or repo |
| Cost/limit-aware model advice | Cloud or multi-user service | Token optimization that lowers first-try success |
| Unified history and search | Replacing the agents' own UIs | Project unusable without the database |
| One-command install, packs | Universal API agent (v2) | Auto-installing third-party code |

### 1.5 Scope v1 (MVP)

Parts 1–5 from §8. Claude and Codex adapters only. Universal API adapter, hub MCP server and harness probing at scale are v2.

---

## 2. Functional requirements

Each requirement has an ID and an acceptance check. "User approval" means an explicit confirm step showing a diff.

### Library & sync (Part 1)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-L1 | Registry entries store install command + description + source ref + hash + license + compat + token cost + risk; no vendored files | schema validation passes for all entries; no third-party file in repo |
| FR-L2 | `hub init` detects installed agents and existing configs and prints a write plan without writing | dry-run output lists every file; zero writes |
| FR-L3 | Compile skills to every enabled agent (junction on Windows, copy fallback recorded in lock) | the same skill is listed by Claude and Codex in a clean test project |
| FR-L4 | Rules: `AGENTS.md` is the single source; `CLAUDE.md` contains an import line | Claude and Codex both receive identical project rules |
| FR-L5 | MCP: one description → `.mcp.json` and Codex `config.toml`; secrets only as env references | `hub mcp test` reports connected for both agents |
| FR-L6 | Hooks: neutral IR → native/adapted/unsupported/unknown per agent, with diff | adapted hook shows diff; unsupported hook offers fallback |
| FR-L7 | `hub.lock` makes installs reproducible; changed hash requires re-approval | fresh clone + `hub install` reproduces the same set |
| FR-L8 | Backup before any write outside the project; `hub undo` restores | undo returns files byte-identical |
| FR-L9 | `hub scout` proposes ≤5 candidates with reason, token cost, license, compat, risk; never installs | scout output contains no install side effects |
| FR-L10 | Project profiles disable unrelated plugins/skills per project | profile reduces listed skills in the test project |

### History & ledger (Part 2)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-H1 | Import Claude (`~/.claude/projects/**/*.jsonl`) and Codex (`~/.codex/sessions/**`, `state_5.sqlite` read-only) | counts match source; re-import is idempotent |
| FR-H2 | Normalize project paths (`C:\`, `C:/`, `\\?\`, `C--Users-…`) to one project | AmpliCore sessions from both agents group under one project |
| FR-H3 | Redact secrets before indexing; never read `auth.json`, `.credentials.json`, `secrets/` | seeded fake keys never appear in the DB |
| FR-H4 | Full-text search across agents; session viewer | query returns hits from both agents |
| FR-H5 | Incremental indexing by byte offset | second run over 8.5 GB finishes in seconds when nothing changed |

### Run, adapters & handoff (Part 3)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-R1 | Adapter interface: detect, capabilities, start, events, limits, stop, readHistory | Claude and Codex adapters pass the same contract tests |
| FR-R2 | `hub run` creates worktree + branch `hub/<task>/<agent>`, optional sparse-checkout | task runs only inside its worktree |
| FR-R3 | Live event stream (message, tool, usage, limit, error, done) | UI shows events within 1 s |
| FR-R4 | Limit detection: Codex `rate_limits` from logs; Claude via CLI if available, else manual entry | Codex % matches the log; Claude shows "no data" honestly |
| FR-R5 | Handoff: WIP commit, card with deterministic facts + cheap-model summary, user-approved restart on another agent | second agent continues a stopped task without user re-explaining |
| FR-R6 | `hub open <agent>` launches the native interactive UI in the right folder | both agents open with applied config |
| FR-R7 | Agents cannot `git push` or publish by default | push attempt is refused |

### Economics & advisor (Part 4)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-E1 | Price table with source URL and verification date; unknown price ≠ 0 | a model with no price row shows "unknown", not $0 (prices live in `registry/prices.json`, overridable in the hub home) |
| FR-E2 | Per-task estimate as a range (tokens, $, % weekly limit) with confidence | every estimate shows low/high and confidence |
| FR-E3 | Calibration from actual runs (weighted tokens per 1% limit, rolling) | after 10 runs the range narrows and is shown |
| FR-E4 | Advice: model + effort + reason; escalation ladder; subagents off unless justified | advice cites the rule that produced it |
| FR-E5 | Outcome tracking: first-try success, rework, actual cost vs estimate | per class × model × effort table |

### Lifecycle & UI (Part 5)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-S1 | 8 stages with output files and gates; stage cannot close without outputs + user OK | gate refuses missing outputs |
| FR-S2 | Project types (web-saas, mobile-app, automation, design-study) with preset skills | mobile-app preset includes the design pipeline |
| FR-S3 | Design stage must use `product-ui-workbench` + `design-quality-loop` | recommender cannot remove them |
| FR-S4 | Web panel: projects/stages, library + approval, history, run, limits/economics, rules view | all screens in 4 themes, desktop + 375 px |
| FR-S5 | `hub diagram` (ascii/mermaid/json) generated from code and configs; `--check` in CI | CI fails when docs diagrams drift |

---

## 3. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 Security | Threat model T1–T10 in SECURITY.md; vulnerability gate before every merge |
| NFR-2 Privacy | Local only; server bound to `127.0.0.1` with session token and Host/Origin checks; no telemetry |
| NFR-3 Platform | Windows 11 first; macOS/Linux supported; Node ≥ the minimum that provides `node:sqlite` (verify; author has 24.14) |
| NFR-4 Install | `npx agent-hub init` trial; `npm i -g agent-hub`; no native modules |
| NFR-5 Performance | Incremental index; UI interactions < 200 ms locally; no full re-scan on start |
| NFR-6 Reliability | Files are the source of truth; DB rebuildable except own runs/estimates (backed up to JSONL) |
| NFR-7 Accessibility | Token contrast ≥ 4.5 for text, ≥ 3 for UI boundaries; real consumers checked in the build |
| NFR-8 i18n | UI in Russian and English; agent-facing files in English |
| NFR-9 Licensing | Core MIT or Apache-2.0; every registry entry carries a license |

---

## 4. Architecture and data model (summary)

Full detail: [ARCHITECTURE.md](ARCHITECTURE.md), [DATA-MODEL.md](DATA-MODEL.md), diagrams in [SCHEMES.md](SCHEMES.md).

- **Stack:** TypeScript monorepo (pnpm): `core`, `cli`, `server` (Hono, HTTP + SSE), `web` (React + Vite), `adapter-claude`, `adapter-codex`, `schemas`.
- **Core modules:** registry + lock, compilers, lifecycle, ledger/index, economics, advisor, handoff, scout.
- **Data:** files in git (`hub.yaml`, `toolkit.yaml`, `hub.lock`, `specs/`, `.hub/handoffs`, `.hub/audit.jsonl`) + SQLite index at `~/.agent-hub/hub.sqlite` (`agent`, `account`, `project`, `session`, `message`+FTS, `task`, `run`, `handoff`, `usage_event`, `limit_snapshot`, `model`, `price`, `estimate`, `estimate_outcome`, `calibration`, `registry_entry`, `install`, `approval`).

---

## 5. Principles

### 5.1 Product principles

1. Files are truth; the database is an index.
2. Foreign data is read-only.
3. Every write outside the project is shown as a diff and approved.
4. External content is data, never instructions.
5. Pin version and hash of every third-party component.
6. Localhost only.
7. Estimates are ranges with confidence; unknown is shown as unknown.
8. Measure first, then optimize; keep only changes that don't lower first-try success.

### 5.2 How agents build this project

1. **One task = one session = one worktree.** Split tasks expected to exceed ~25 M total tokens.
2. **Spec and acceptance test before code** (TDD).
3. **Cheapest capable model first**, escalate on evidence (§6.3).
4. **No subagents by default** (57 % of the author's Codex tokens went to subagent threads).
5. **Graph before grep** (`graphify` report first), **diff-only review**.
6. **Minimal code** (`ponytail`; `lite` level on security, path and process code).
7. **Honest statuses**: observed / inferred / proposed / approved (from the author's design pipeline), applied to every report.
8. **Stable short rules** so prompt cache stays warm.

---

## 6. Model routing and call specifications

Decision by the author: **Opus 5.5** for plans and hard architecture, **Sonnet 5.5** for the main work, Opus called when Sonnet is blocked. Effort tuned for the best result at the lowest token cost. Effort names below are generic; `hub doctor` verifies which levels the installed CLI exposes.

### 6.1 Call types

| Call | Model · effort | Input (context budget) | Output | Skills | Stop condition |
|---|---|---|---|---|---|
| C1 Plan / spec / part design | Opus 5.5 · high | brief, ARCHITECTURE/DATA-MODEL excerpts, graph report | `specs/<part>/spec.md`, `plan.md`, `tasks.md` | brainstorming, writing-plans, senior-architect, grill-me, speckit-* | gate: user approval |
| C2 Critical ADR (4 total: security model, data/lock format, adapter interface, handoff protocol) | Opus 5.5 · highest available | the decision's context + alternatives | `docs/adr/NNN-*.md` | senior-architect, security-review | user approval |
| C3 Implement task | Sonnet 5.5 · medium | task spec + touched files + graph slice | code + tests, green CI | test-driven-development, ponytail, verification-before-completion | tests green + security gate |
| C4 Debug | Sonnet 5.5 · high | failing test output (trimmed) + diff | fix | systematic-debugging | test green, or escalate |
| C5 Escalation | Opus 5.5 · high | **handoff card** + failing evidence (not the full transcript) | root cause + fix plan or fix | systematic-debugging, senior-architect | unblocked → return to Sonnet |
| C6 Review | Opus 5.5 · medium for Parts 1/3 and security; Sonnet 5.5 · medium otherwise | diff only + spec + T1–T10 checklist | findings list | requesting-code-review, security-review, code-review | findings resolved |
| C7 Mechanical (docs, renames, formatting) | Sonnet 5.5 · low | exact instruction + files | change | ponytail, simplify | done |
| C8 Handoff summary / lesson draft (hub runtime) | Haiku 5.5 · low | facts block + last events | card text / lesson candidate | hub-handoff | card written |

### 6.2 Effort policy

- Default for implementation in the router (v0.2 P3.1, the user's principle) is **Sonnet at high**; effort is a routed dimension (model, effort), `xhigh` never wins for code without data. **High** also for debugging, process/concurrency code (adapters, runner), security boundaries.
- **Highest** only for the 4 critical ADRs (C2).
- **Low** for mechanical work.
- Effort is re-tuned per class from first-try success data after 10 sessions per cell (the author's history shows effort level barely changes session size, so it must be justified by success, not assumed).

### 6.3 Escalation ladder

```
Sonnet medium ─(same test fails twice | >25 tool turns without new green test)─► Sonnet high
Sonnet high   ─(still blocked)──────────────────────────────────────────────────► Opus high + handoff card
Opus high     ─(unblocked)──────────────────────────────────────────────────────► back to Sonnet medium with a short card
Any change touching T1–T10 boundaries ──────────────────────────────────────────► mandatory Opus review (C6)
Spec ambiguity ─────────────────────────────────────────────────────────────────► question to the user (or Opus C1)
Claude limit reached ───────────────────────────────────────────────────────────► (optional, author decides) Codex gpt-6.1-sol via handoff
```

### 6.4 Subagent policy

Off by default. Allowed only when subtasks are independent, each needs a small context, and the estimate shows a gain; diff-only review may use one subagent. Parallelism is done with **separate worktrees and sessions**, not subagents inside one context.

---

## 7. Skills, plugins and MCP for building

Full list and rationale: [TOOLING.md](TOOLING.md).

| Area | Mandatory | Supporting |
|---|---|---|
| Process | superpowers: brainstorming, writing-plans, executing-plans, test-driven-development, systematic-debugging, verification-before-completion, using-git-worktrees, requesting/receiving-code-review, finishing-a-development-branch | feature-dev agents, simplify, commit-commands |
| Clarify | grill-me, discovery-interview | — |
| Architecture | **senior-architect** | speckit-*, spec-kit, delivery-workflow, unit-economics (from AmpliCore) |
| Code size / tokens | **ponytail**, graphify (one graph per project) | candidates via scout: caveman, rtk, headroom, pxpipe (unverified) |
| Design | **product-ui-workbench** (author's pipeline, v0.10.1) + **design-quality-loop** | frontend-design, ui-ux-pro-max, design-system, react-best-practices, webapp-testing, dataviz |
| Security | security-review, security-best-practices, review-security | Strix skills; gitleaks/semgrep/osv-scanner/trivy via Docker; Aikido and CodeRabbit only if the author approves |
| MCP | built-in browser (UI checks) | **Mobbin**, **shadcn** (Part 5 only, see MCP-SETUP.md); context7 (currently failing → WebFetch) |

Development profile disables unrelated plugins (Airflow triplicates, cloud/service plugins, unused LSPs) — measured skill listing today: ~301 skills / ~119 k description chars in Claude Code.

---

## 8. Iteration plan

Sessions are task-sized agent sessions. Model split per iteration follows §6. Each iteration ends with: tests green, security gate, diagram check, docs updated, cross-review.

### I0 — Bootstrap (6 sessions: Opus 4 · Sonnet 2)

| Task | Call | Output |
|---|---|---|
| T0.1 Approve this plan; write ADR-001…009 stubs | C1 | `docs/adr/` |
| T0.2 Repo scaffold: pnpm workspace, TS strict, lint, test runner, CI | C3 | green CI on empty packages |
| T0.3 `AGENTS.md`/`CLAUDE.md`, dev profile (plugins off) | C7 | rules in repo, profile applied manually |
| T0.4 Security gate scripts (Docker scanners, `npm audit`) | C3 | `scripts/security.*` |
| T0.5 Golden task set (10 tasks from history) for A/B measurement | C1 | `eval/golden/` |
| T0.6 Part 1 spec + tasks | C1 | `specs/001-library/` |

### I1 — Library & sync (14 · Opus 3 · Sonnet 11)

Registry schema + validation · entry loader · `hub.lock` · skills compiler (junction) · rules compiler · MCP compiler (JSON/TOML) · hooks IR + compat matrix · `hub init` dry-run plan · backup/undo · `hub doctor` · aitmpl source adapter · scout v0 · `hub diagram arch|data` v0 · project profiles.
**Exit:** FR-L1…L10. Dogfood: the hub repo's own Claude/Codex config comes from `hub init`.

### I2 — History & ledger (12 · Opus 2 · Sonnet 10)

Path normalization · Claude importer · Codex importer (read-only SQLite + rollouts) · secret redaction · FTS index · incremental offsets · `hub history` CLI · minimal history screen.
**Exit:** FR-H1…H5. Starts calibration data collection.

### I3 — Adapters, run, handoff (16 · Opus 5 · Sonnet 11)

Adapter contract + tests · Claude adapter · Codex adapter · runner + worktree/sparse · event stream (SSE) · limits readers · handoff card (facts + Haiku summary) · approval flow · push guard · `hub open`.
**Exit:** FR-R1…R7. A real task stopped on one agent is finished by the other without re-explaining.

### I4 — Economics & advisor (8 · Opus 2 · Sonnet 6)

Price table + sources · token profiles by task class · estimate ranges · calibration · advisor rules + explanations · outcome tracking.
**Exit:** FR-E1…E5; estimates compared with actuals for ≥10 runs.

### I5 — Lifecycle & UI (14 · Opus 3 · Sonnet 11)

Stage engine + gates · project-type presets · design stage wiring (workbench + quality loop) · web panel screens in 4 themes · `hub diagram stages|project|handoff|routing` · `--check` in CI.
**Exit:** FR-S1…S5. A new project passes stages 1–6 end to end. UI built through the author's design pipeline with Mobbin/shadcn.

### Cross-cutting (12 · Opus 2 · Sonnet 10) and reviews (14 · Opus 6 · Sonnet 8)

Packaging, npm provenance, docs EN, release; cross-reviews on diffs per iteration.

**Totals:** 96 sessions — Opus 27, Sonnet 69 (same split as MODELS-AND-LIMITS).

---

## 9. Unit economics (summary)

From [MODELS-AND-LIMITS.md](MODELS-AND-LIMITS.md), API-equivalent (subscriptions are not billed per token; numbers compare scenarios):

| Scenario (session size from the author's history) | Opus 27 + Sonnet 69 |
|---|---:|
| Disciplined (median) | ≈ $120 |
| Typical (≈ p75) | ≈ $260 |
| Current habits (mean, long sessions) | ≈ $610 |

Claude Pro limit share cannot be estimated yet (no measurements). First 10 sessions record `/usage` before/after. Optional safety net: Codex continues via handoff when Claude is limited.

---

## 10. Definition of Done (every task)

1. Acceptance test written first and green.
2. `hub`-level security gate clean (secrets, deps, semgrep) or justified in an ADR.
3. Diagrams regenerated; `hub diagram --check` passes.
4. Docs updated where behavior changed.
5. Reviewed on diff by the other model class (§6.1 C6).
6. Status reported with honest labels; nothing "approved" without the author.

---

## 11. Risks and open questions

| Risk / question | Plan |
|---|---|
| CLI headless flags and event formats may differ by version | verify in I3 before writing adapters |
| Claude limit % may not be readable automatically | manual entry + token-based estimate |
| Claude Pro may not fit 96 sessions in 1–2 weeks | measure in I0–I1; optional Codex safety net |
| Subscription terms for orchestrated CLI use | check before publishing |
| Codex hook events beyond SessionStart/Stop/SubagentStop/Interrupt unverified | test in I1 |
| Effect of ponytail/graphify on this codebase unknown | A/B on golden tasks in I0–I1 |
| Third-party component licenses | license field mandatory; panel warns |

## 12. Decisions so far (by the author)

- Stack A: TypeScript, local web panel, publishable on GitHub, packs installable.
- Library stores commands + descriptions, not files; adaptation at stage 3 with approval.
- Claude Opus 5.5 for plans/architecture, Sonnet 5.5 for main work, Opus on blockers.
- No subagents when more expensive; token-reducing skills: graphify, ponytail.
- Mandatory skills: senior-architect (architecture), ponytail (small code), product-ui-workbench + design-quality-loop (design).
- Continuous skill search (scout).
- Vulnerability checks on every iteration.
- Design: dark and light, two accents — bright green and orange.
