# Agent Hub — модель данных

> Статус: **v0.2**, 2026-10-22. Связано с [ARCHITECTURE.md](ARCHITECTURE.md). **Реализация (v0.1.0):** файлы конфигурации в JSON, не YAML (ADR-011); фактическая схема SQLite — `src/history/store.ts` (таблицы `project`, `session`, `message` + FTS5, `usage_event`, `limit_snapshot`, `source_file_state`, `run`, `run_event`); актуальную схему печатает `hub diagram data`. Таблицы экономики и каталога из раздела 2.5–2.7 пока не созданы: оценки считаются на лету, реестр живёт в файлах.

Данные делятся на два слоя.

| Слой | Где | Что | Можно потерять? |
|---|---|---|---|
| **Файлы** (источник истины) | в репозитории проекта: `hub.yaml`, `hub.lock`, `toolkit.yaml`, `specs/`, `.hub/` | конфигурация, выбор компонентов, результаты этапов, карточки передачи, аудит | нет, лежат в git |
| **База** (индекс) | `~/.agent-hub/hub.sqlite` | история сессий, поиск, учёт токенов и лимитов, оценки, кэш каталога | да, пересобирается из чужих логов и файлов |

Исключения, которые из чужих логов не восстановить: журнал ваших запусков через панель (`run`), решения по оценкам (`estimate`, `calibration`). Они регулярно выгружаются в `~/.agent-hub/backup/*.jsonl`.

## 1. Файловые форматы

### 1.1. `hub.yaml` — проект

```yaml
version: 1
project:
  slug: amplicore
  type: web-saas            # тип из stages/ и packs/: web-saas | mobile-app | automation | ...
agents:
  - id: claude
    enabled: true
  - id: codex
    enabled: true
rules:
  source: AGENTS.md         # единственный источник правил
  claude_pointer: true      # CLAUDE.md = строка-ссылка на AGENTS.md
worktrees:
  root: ../<slug>-worktrees
  sparse: true
limits:
  handoff_threshold_percent: 95
  auto_handoff: false       # по умолчанию подтверждает человек
```

### 1.2. `toolkit.yaml` — выбранные инструменты проекта (этап 3)

```yaml
stage: 3
approved_at: 2026-10-22T14:00:00Z
selected:
  - id: skill/grill-me
    why: уточнение контекста на этапе 2
  - id: mcp/context7
    why: актуальная документация библиотек
rejected:
  - id: plugin/aws-serverless
    why: проект не использует AWS
```

### 1.3. `hub.lock` — воспроизводимая установка

```yaml
version: 1
generated_at: 2026-10-22T14:05:00Z
entries:
  - id: skill/grill-me
    source: { type: github, repo: owner/repo, ref: 3f2a9c1, path: skills/grill-me }
    version: 1.2.0
    hash: sha256-…                # хэш содержимого на момент установки
    license: MIT
    token_cost: 180               # размер описания в контексте, токены
    targets:
      claude: { status: native,  installed_to: .claude/skills/grill-me }
      codex:  { status: native,  installed_to: .agents/skills/grill-me }
  - id: hook/session-brief
    source: { type: aitmpl, ref: hooks/session-brief, version: 0.4.1 }
    hash: sha256-…
    license: Apache-2.0
    targets:
      claude: { status: native }
      codex:
        status: adapted
        changes: ["${CLAUDE_PLUGIN_ROOT} → ${PLUGIN_ROOT}"]
        approved: true
        diff_hash: sha256-…
    approval: { by: user, at: 2026-10-22T14:03:10Z }
```

Правила: запись попадает в `hub.lock` только после подтверждения; смена `hash` при обновлении снова требует подтверждения.

### 1.4. Запись реестра `registry/entries/<kind>/<name>.yaml`

Реестр хранит **команду и описание**, а не файлы.

```yaml
id: skill/grill-me
kind: skill                    # skill | plugin | mcp | agent | command | hook | rule-pack | stage-pack
title: Grill Me
description: Допрос по плану или дизайну, чтобы выявить пробелы до работы.
source:
  type: github                 # github | npm | aitmpl | local
  repo: owner/repo
  path: skills/grill-me
  ref: 3f2a9c1                 # коммит, а не ветка
install:
  command: "hub add skill/grill-me"      # что показывается пользователю
license: MIT
tags: [clarification, planning]
stages: [2]
project_types: ["*"]
compat:
  claude: native
  codex: native
token_cost: 180
risk:                          # что может делать компонент
  executes_code: false
  network: false
  writes_outside_project: false
```

### 1.5. Этап `stages/<name>.yaml`

```yaml
id: architecture
order: 4
title: Архитектура и модель данных
inputs: [brief.md, toolkit.yaml]
outputs: [docs/architecture.md, docs/data-model.md]
skills: [skill/senior-architect]
recommended_agent: { task_class: design, model_hint: strong, effort_hint: high }
gate:
  - all_outputs_exist
  - adr_for_each_decision: true
  - user_approval: true
```

### 1.6. Карточка передачи `.hub/handoffs/<id>.md`

Формат: YAML-шапка (факты) + короткий текст (смысл).

```markdown
---
id: ho-2026-10-22-0007
from: { agent: codex, model: gpt-6.1-sol, effort: high, run: run-0412 }
to:   { agent: claude, model: claude-opus-5-5, effort: high }
reason: limit_reached
task: specs/003-context-readiness/tasks.md#T014
branch: hub/T014/codex
base_sha: dde331f
head_sha: 9ab4c2e
files_changed: [backend/lib/ctx.ts, backend/tests/ctx.test.ts]
tests: { command: "npm test", last_result: failing, failing: ["ctx handles empty input"] }
facts_from: git+logs            # эти поля собраны кодом, не моделью
---
## Цель
…
## Что сделано
…
## На чём остановились
…
## Следующие шаги
1. …
## Открытые вопросы
…
```

Поля в шапке заполняет код. Разделы ниже пишет дешёвая модель по логам и diff; в шапке остаётся отметка, какая модель их написала.

## 2. Схема базы

Типы: `TEXT`, `INTEGER`, `REAL`, времена в ISO-8601 UTC. Первичные ключи — ULID в `TEXT`.

### 2.1. Агенты и аккаунты

```sql
CREATE TABLE agent (
  id TEXT PRIMARY KEY,                -- 'claude' | 'codex' | ...
  kind TEXT NOT NULL,                 -- 'cli' | 'api'
  cli_path TEXT, version TEXT, detected_at TEXT
);

CREATE TABLE account (                -- подписка или ключ; сами секреты НЕ хранятся
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id),
  label TEXT NOT NULL,                -- 'Claude Pro', 'Codex ProLite'
  plan_type TEXT,                     -- 'claude_pro' | 'prolite' | 'pro' | ...
  limit_window_minutes INTEGER,       -- 10080 для недельного окна Codex
  extra_usage_enabled INTEGER,        -- 0/1, если известно
  notes TEXT
);
```

### 2.2. Проекты и пути

```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  root_path_norm TEXT NOT NULL,       -- нормализованный путь: нижний регистр диска, '/' , без '\\?\'
  git_remote TEXT,
  created_at TEXT
);

CREATE TABLE project_path_alias (     -- все написания пути из чужих хранилищ
  project_id TEXT REFERENCES project(id),
  path_raw TEXT NOT NULL,
  path_norm TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'claude-dir' | 'claude-cwd' | 'codex-cwd' | 'git-worktree'
  PRIMARY KEY (project_id, path_raw)
);
```

### 2.3. Сессии и сообщения (история обоих агентов)

```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent(id),
  native_id TEXT NOT NULL,            -- sessionId Claude / id треда Codex
  project_id TEXT REFERENCES project(id),
  parent_session_id TEXT REFERENCES session(id),  -- субагенты, форки
  origin TEXT,                        -- 'cli' | 'desktop' | 'hub' | 'exec'
  title TEXT, model TEXT, effort TEXT,
  started_at TEXT, ended_at TEXT,
  source_kind TEXT NOT NULL,          -- 'claude-jsonl' | 'codex-rollout'
  source_path TEXT NOT NULL,
  tokens_uncached_in INTEGER, tokens_cached_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER,
  archived INTEGER DEFAULT 0,
  UNIQUE (agent_id, native_id)
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,                 -- 'user' | 'assistant' | 'tool' | 'system'
  ts TEXT, tool_name TEXT, text TEXT, -- текст после вырезания секретов, без base64
  UNIQUE (session_id, ordinal)
);
CREATE VIRTUAL TABLE message_fts USING fts5(text, content='message', content_rowid='rowid');

CREATE TABLE source_file_state (      -- инкрементальный индекс
  path TEXT PRIMARY KEY,
  size INTEGER, mtime_ns INTEGER,
  byte_offset INTEGER, last_ordinal INTEGER
);
```

### 2.4. Задачи, запуски, передачи

```sql
CREATE TABLE task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  spec_ref TEXT NOT NULL,             -- 'specs/003-…/tasks.md#T014'
  title TEXT, stage INTEGER, class TEXT,   -- class: design|implement|review|test|docs|mechanical
  status TEXT, deps_json TEXT
);

CREATE TABLE run (                    -- запуск агента через панель
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES task(id),
  session_id TEXT REFERENCES session(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  account_id TEXT REFERENCES account(id),
  model TEXT, effort TEXT,
  worktree_path TEXT, branch TEXT, base_sha TEXT, head_sha TEXT,
  started_at TEXT, ended_at TEXT,
  outcome TEXT,                       -- 'done' | 'limit' | 'failed' | 'stopped'
  estimate_id TEXT REFERENCES estimate(id)
);

CREATE TABLE handoff (
  id TEXT PRIMARY KEY,
  from_run_id TEXT NOT NULL REFERENCES run(id),
  to_run_id TEXT REFERENCES run(id),
  reason TEXT,                        -- 'limit_reached' | 'limit_soon' | 'manual' | 'quality'
  card_path TEXT NOT NULL,            -- файл в репозитории проекта
  summarizer_model TEXT,
  created_at TEXT
);
```

### 2.5. Токены, лимиты, цены

```sql
CREATE TABLE usage_event (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  run_id TEXT REFERENCES run(id),
  ts TEXT NOT NULL, model TEXT,
  tokens_uncached_in INTEGER, tokens_cached_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER
);

CREATE TABLE limit_snapshot (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  ts TEXT NOT NULL,
  window_minutes INTEGER, used_percent REAL, resets_at TEXT,
  source TEXT NOT NULL,               -- 'codex-log' | 'cli-usage' | 'manual' | 'estimate'
  raw_json TEXT
);

CREATE TABLE model (
  id TEXT PRIMARY KEY,                -- 'claude-opus-5-5', 'gpt-6.1-sol'
  provider TEXT, family TEXT, context_window INTEGER, status TEXT
);

CREATE TABLE price (                  -- доллары за 1 млн токенов
  model_id TEXT NOT NULL REFERENCES model(id),
  valid_from TEXT NOT NULL,
  tier_condition TEXT,                -- например 'prompt<=100k'
  input REAL, cache_read REAL, cache_write_5m REAL, cache_write_1h REAL, output REAL,
  source_url TEXT NOT NULL, verified_at TEXT,
  PRIMARY KEY (model_id, valid_from, tier_condition)
);
```

### 2.6. Экономика и калибровка

```sql
CREATE TABLE estimate (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES task(id),
  model_id TEXT REFERENCES model(id), effort TEXT,
  tokens_p50_json TEXT, tokens_p90_json TEXT,     -- {uncached_in, cached_in, out}
  usd_api_eq_low REAL, usd_api_eq_high REAL,
  percent_low REAL, percent_high REAL,            -- процент недельного лимита аккаунта
  confidence TEXT,                                -- 'low' | 'medium' | 'high'
  rationale TEXT, created_at TEXT
);

CREATE TABLE estimate_outcome (
  estimate_id TEXT PRIMARY KEY REFERENCES estimate(id),
  run_id TEXT REFERENCES run(id),
  actual_tokens_json TEXT, actual_usd_api_eq REAL, actual_percent_delta REAL,
  success INTEGER, rework_needed INTEGER          -- качество: получилось с первой попытки?
);

CREATE TABLE calibration (            -- скользящий коэффициент «взвешенных млн токенов на 1%»
  account_id TEXT NOT NULL REFERENCES account(id),
  model_id TEXT, effort TEXT,
  weighted_mtok_per_percent REAL, n INTEGER, p10 REAL, p90 REAL, updated_at TEXT,
  PRIMARY KEY (account_id, model_id, effort)
);
```

Взвешенные токены: `uncached_in + w_cached * cached_in + w_out * out`, веса по умолчанию `w_cached = 0.1`, `w_out = 5` (отношения цен API), хранятся в настройках и подлежат калибровке.

### 2.7. Реестр и установки

```sql
CREATE TABLE registry_entry (         -- кэш каталога; источник — файлы registry/ и внешние источники
  id TEXT PRIMARY KEY, kind TEXT, source_type TEXT, source_ref TEXT, version TEXT, hash TEXT,
  license TEXT, description TEXT, tags_json TEXT, stages_json TEXT, project_types_json TEXT,
  compat_json TEXT, token_cost INTEGER, risk_json TEXT, fetched_at TEXT
);

CREATE TABLE install (
  project_id TEXT NOT NULL REFERENCES project(id),
  entry_id TEXT NOT NULL REFERENCES registry_entry(id),
  version TEXT, hash TEXT,
  targets_json TEXT,                  -- статусы по агентам: native|adapted|unsupported|unknown
  approved_at TEXT, diff_hash TEXT,
  PRIMARY KEY (project_id, entry_id)
);

CREATE TABLE approval (               -- зеркало файла .hub/audit.jsonl
  id TEXT PRIMARY KEY, ts TEXT, actor TEXT, action TEXT, target TEXT, diff_hash TEXT, decision TEXT
);
```

## 3. Связи

```mermaid
erDiagram
  agent ||--o{ account : has
  agent ||--o{ session : produces
  project ||--o{ session : contains
  project ||--o{ task : has
  project ||--o{ install : uses
  task ||--o{ run : executed_by
  run ||--o| session : maps_to
  run ||--o{ handoff : from
  handoff }o--|| run : to
  run ||--o| estimate : planned_by
  estimate ||--o| estimate_outcome : compared_with
  account ||--o{ limit_snapshot : measured
  account ||--o{ calibration : tuned
  model ||--o{ price : priced
  registry_entry ||--o{ install : installed_as
  session ||--o{ message : has
  session ||--o{ usage_event : counts
```

## 4. Правила целостности

- `session` создаётся только импортом или запуском; изменять источники нельзя.
- Импорт идемпотентен: ключ `(agent_id, native_id)`, продолжение чтения по `source_file_state`.
- Перед записью в `message.text` текст проходит вырезание секретов; сообщения с вложениями изображений хранят только отметку.
- `price` не перезаписывается: новые цены добавляются строкой с новой `valid_from`; `verified_at` показывает давность.
- `estimate` после запуска не меняется; сравнение с фактом хранится в `estimate_outcome`.
- `limit_snapshot` с `source = 'estimate'` всегда помечается в интерфейсе как оценка, а не измерение.
- Удаление базы безопасно для проекта: из чужих логов пересобираются `session`, `message`, `usage_event`, `limit_snapshot` (для Codex); `run`, `estimate`, `calibration` восстанавливаются из резервной копии.
