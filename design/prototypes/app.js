// Agent Hub prototype S1 — static study. Synthetic fixture only; no network calls.
(() => {
  const q = new URLSearchParams(location.search);
  const S = {
    v: q.get("v") === "b" ? "b" : "a",
    theme: q.get("theme") === "light" ? "light" : "dark",
    screen: ["today", "task", "toolkit"].includes(q.get("screen")) ? q.get("screen") : "today",
    material: q.get("material") === "opaque" ? "opaque" : "glass",
    scope: "waiting",
    tkFilter: "all",
  };
  const root = document.documentElement;
  root.dataset.variant = S.v;
  root.dataset.accent = S.v === "a" ? "green" : "orange";
  root.dataset.theme = S.theme;
  root.dataset.screen = S.screen;
  if (S.material === "opaque") root.dataset.material = "opaque";

  const href = (patch) => {
    const p = new URLSearchParams({ v: S.v, theme: S.theme, screen: S.screen });
    if (S.material === "opaque") p.set("material", "opaque");
    for (const [k, val] of Object.entries(patch)) val == null ? p.delete(k) : p.set(k, val);
    return "?" + p.toString();
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- Fixture ----------
  const project = { name: "AmpliCore", stage: "Этап 7 · Исполнение" };
  const waiting = [
    { id: "T016", kind: "handoff", title: "Хуки → Codex", reason: "Codex упёрся в недельный лимит (95%) и остановился", since: "14:31" },
    { id: "S3", kind: "approve", title: "Этап 3 · инструменты проекта", reason: "5 предложений ждут подтверждения", since: "13:05" },
    { id: "T014", kind: "review", title: "Компилятор MCP", reason: "Готов к ревью Opus 5.5 по diff", since: "12:40" },
  ];
  const running = [
    { id: "T015", title: "Адаптер Codex", agent: "claude", model: "Opus 5.5 · high", step: "пишет тесты контракта", elapsed: "12 мин", state: "ok" },
    { id: "T017", title: "Sparse-checkout в worktree", agent: "claude", model: "Sonnet 5.5 · medium → high", step: "тест упал дважды, эскалация", elapsed: "7 мин", state: "warn" },
  ];
  const limits = [
    { name: "Codex", plan: "ProLite · неделя", used: 95, reset: "сброс через 2 д 4 ч", src: "из лога Codex", risk: true },
    { name: "Claude", plan: "Pro · 5-часовое окно", used: 38, reset: "сброс через 3 ч 12 мин", src: "введено вручную в 14:10", risk: false },
  ];
  const tools = [
    { id: "product-ui-workbench", name: "product-ui-workbench", kind: "плагин", mandatory: true, why: "Ваш дизайн-пайплайн: обязателен на этапе дизайна", tokens: 310, claude: ["adapted", "junction"], codex: ["native", ""], lic: "MIT", risk: ["warn", "запускает локальные Python-скрипты"] },
    { id: "graphify", name: "graphify", kind: "скилл", mandatory: true, why: "Граф проекта: агент читает узлы, а не файлы целиком", tokens: 140, claude: ["native", ""], codex: ["native", ""], lic: "MIT", risk: ["ok", "низкий"] },
    { id: "senior-architect", name: "senior-architect", kind: "скилл", mandatory: false, why: "Архитектура, компромиссы, генерация диаграмм", tokens: 220, claude: ["native", ""], codex: ["native", ""], lic: "не указана", risk: ["ok", "низкий"] },
    { id: "ponytail", name: "ponytail", kind: "скилл", mandatory: false, why: "Минимальный код; автор заявляет −22% токенов, проверим замером", tokens: 260, claude: ["native", ""], codex: ["native", ""], lic: "MIT", risk: ["ok", "низкий"] },
    { id: "shadcn-mcp", name: "shadcn MCP", kind: "MCP", mandatory: false, why: "Реальные компоненты для интерфейса панели", tokens: 1900, claude: ["native", ".mcp.json"], codex: ["adapted", "config.toml"], lic: "MIT", risk: ["warn", "сеть: npx при запуске"] },
  ];
  const selected = new Set(tools.map((t) => t.id));

  // ---------- Icons ----------
  const I = {
    today: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l1 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z"/></svg>',
    tasks: '<svg class="icon" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
    library: '<svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><path d="M16.5 13v7M13 16.5h7"/></svg>',
    history: '<svg class="icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
    limits: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/></svg>',
    handoff: '<svg class="icon" viewBox="0 0 24 24"><path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/></svg>',
    approve: '<svg class="icon" viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>',
    review: '<svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
    back: '<svg class="icon" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    close: '<svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    branch: '<svg class="icon" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-6 7"/></svg>',
  };
  const kindIcon = { handoff: ["handoff", "warn"], approve: ["approve", ""], review: ["review", "info"] };
  const av = (a) => `<span class="av av-${a}" aria-hidden="true">${a === "claude" ? "C" : "O"}</span>`;

  // ---------- Navigation ----------
  const navItems = [
    { key: "today", label: "Сегодня", icon: "today", badge: waiting.length },
    { key: "task", label: "Задачи", icon: "tasks" },
    { key: "toolkit", label: "Библиотека", icon: "library" },
    { key: "history", label: "История", icon: "history", off: true },
    { key: "limits", label: "Лимиты", icon: "limits", off: true },
  ];
  const navLink = (n, cls) => {
    const cur = n.key === S.screen ? ' aria-current="page"' : "";
    const off = n.off ? ' aria-disabled="true" title="Не входит в прототип"' : "";
    const badge = n.badge ? `<span class="badge">${n.badge}</span>` : "";
    return `<a class="${cls}" href="${n.off ? "#" : href({ screen: n.key })}"${cur}${off}>${cls === "tab" ? "" : I[n.icon]}<span>${n.label}</span>${badge}</a>`;
  };
  const rail = () => `<nav class="rail glass" aria-label="Разделы"><div class="logo" aria-label="agent hub">h</div>${navItems.map((n) => navLink(n, "nav-item")).join("")}<div class="spacer"></div></nav>`;
  const tablens = () => `<nav class="tablens glass" aria-label="Разделы"><span class="logo"><i></i>agent hub</span>${navItems.map((n) => navLink(n, "tab")).join("")}</nav>`;
  const dock = () => `<nav class="dock glass" aria-label="Разделы (мобильные)">${navItems.filter((n) => !n.off || n.key === "history").slice(0, 4).map((n) => navLink(n, "nav-item")).join("")}</nav>`;
  const study = () => {
    const l = (label, patch, cur) => `<a href="${href(patch)}"${cur ? " aria-current" : ""}>${label}</a>`;
    return `<div class="study glass collapsed" aria-label="Переключатель прототипа">
      <a class="toggle" href="#" data-act="study">Вариант ${S.v.toUpperCase()} · ${S.theme === "dark" ? "тёмная" : "светлая"}</a><span class="sep"></span>
      ${l("A · зелёный", { v: "a" }, S.v === "a")}${l("B · оранжевый", { v: "b" }, S.v === "b")}<span class="sep"></span>
      ${l("Тёмная", { theme: "dark" }, S.theme === "dark")}${l("Светлая", { theme: "light" }, S.theme === "light")}<span class="sep"></span>
      ${l("Стекло", { material: null }, S.material === "glass")}${l("Непрозрачно", { material: "opaque" }, S.material === "opaque")}</div>`;
  };

  // ---------- Today ----------
  const decision = () => {
    const d = waiting[0];
    return `<section class="decision" aria-labelledby="dec-title">
      <div>
        <div class="kicker"><span class="dot"></span>Нужно ваше решение · с ${d.since}</div>
        <h2 class="t-entity" id="dec-title"><span class="mono">${d.id}</span> · ${esc(d.title)}</h2>
        <p class="why">${esc(d.reason)}. Работа сохранена в ветке, карточка передачи собрана — следующий агент продолжит без повторных объяснений.</p>
        <div class="facts"><span class="chip chip-line">2 файла изменены</span><span class="chip chip-err">1 тест падает</span><span class="chip chip-line mono">hub/T016/codex</span></div>
        <div class="next"><span class="t-meta">Предлагаю передать:</span><span class="agent-badge">${av("claude")}Claude Sonnet 5.5 · medium</span><span class="t-meta">окно Claude свободно на 62%</span></div>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href="${href({ screen: "task" })}" data-testid="decision-primary">Передать Claude Sonnet</a>
        <button class="btn btn-glass" type="button" data-act="open-card" data-testid="decision-open">Карточка передачи</button>
        <button class="btn btn-text" type="button">Подождать сброса Codex · 2 д 4 ч</button>
      </div>
    </section>`;
  };
  const rowHtml = (it) => {
    if (it.type === "w") {
      const [ic, tone] = kindIcon[it.kind];
      const target = it.kind === "approve" ? href({ screen: "toolkit" }) : "#";
      return `<a class="row plate" href="${target}"><span class="lead ${tone}">${I[ic]}</span><span><span class="title"><span class="mono">${it.id}</span>${esc(it.title)}</span><span class="sub">${esc(it.reason)}</span></span><span class="right"><span class="t-meta mono">${it.since}</span></span></a>`;
    }
    const chip = it.state === "warn" ? '<span class="chip chip-warn"><span class="dot"></span>эскалация</span>' : '<span class="chip chip-ok"><span class="dot"></span>идёт</span>';
    return `<a class="row plate${it.state === "warn" ? " escalated" : ""}" href="#"><span class="agent-badge" style="padding:0;background:none;box-shadow:none">${av(it.agent)}</span><span><span class="title"><span class="mono">${it.id}</span>${esc(it.title)}</span><span class="sub">${esc(it.model)} · ${esc(it.step)}</span></span><span class="right">${chip}<span class="t-meta">${it.elapsed}</span></span></a>`;
  };
  // R1/F4: two always-visible groups instead of a pill filter, so escalated work never hides behind a click.
  const listSection = () => {
    const more = waiting.slice(1).map((w) => ({ ...w, type: "w" }));
    const run = running.map((r) => ({ ...r, type: "r" }));
    const esc_n = running.filter((r) => r.state === "warn").length;
    return `<section class="group" aria-labelledby="wait-title">
        <div class="section-head"><h3 class="t-section" id="wait-title">Ещё ждут вас <span class="t-meta">${more.length}</span></h3></div>
        <div class="list">${more.map(rowHtml).join("") || '<div class="empty plate">Больше ничего не ждёт</div>'}</div>
      </section>
      <section class="group" aria-labelledby="run-title">
        <div class="section-head"><h3 class="t-section" id="run-title">Идут сейчас <span class="t-meta">${run.length}</span></h3>${esc_n ? `<span class="chip chip-warn">${esc_n} с эскалацией</span>` : ""}</div>
        <div class="list">${run.map(rowHtml).join("")}</div>
      </section>`;
  };
  const limitsPanel = () => `<section class="panel plane" aria-labelledby="lim-title">
      <div class="section-head"><h3 class="t-section" id="lim-title">Лимиты</h3><span class="t-meta">остаток</span></div>
      ${limits.map((l) => `<div class="limit">
        <div class="top"><span class="t-label">${l.name} <span class="t-meta">${l.plan}</span></span><span class="val">${100 - l.used}%</span></div>
        <div class="meter ${l.risk ? "risk" : ""}"><b style="width:${100 - l.used}%"></b></div>
        <div class="bot"><span class="t-meta">${l.reset}</span>${l.risk ? '<span class="chip chip-warn">почти исчерпан</span>' : `<span class="t-meta">${l.src}</span>`}</div>
      </div>`).join("")}
    </section>`;
  const today = () => {
    const head = `<header class="head"><div><div class="ctx"><span class="t-meta">${project.name} · ${project.stage}</span></div><h1 class="t-page">Сегодня</h1></div><span class="t-meta">${running.length} задачи идут · обновлено 14:32</span></header>`;
    if (S.v === "a") return `<div class="wrap">${head}${decision()}<div class="grid-today"><div>${listSection()}</div><aside class="side">${limitsPanel()}</aside></div></div>`;
    return `<div class="window plane">${head}<div class="b-top">${decision()}<aside class="side">${limitsPanel()}</aside></div>${listSection()}</div>`;
  };

  // ---------- Task ----------
  const task = () => {
    const head = `<header class="head"><div><div class="ctx"><a class="crumb" href="${href({ screen: "today" })}">${I.back}Сегодня</a></div>
      <h1 class="t-page"><span class="mono">T016</span> · Хуки → Codex</h1>
      <div class="status-line"><span class="chip chip-warn"><span class="dot"></span>Остановлен: лимит Codex 95%</span><span class="t-meta">14:31 · gpt-6.1-sol · high · спецификация specs/001-library/tasks.md#T016</span></div></div></header>`;
    const card = `<section class="card plane" aria-labelledby="card-title">
        <div class="section-head"><h2 class="t-section" id="card-title">Карточка передачи</h2><span class="chip chip-line">факты из git и логов</span></div>
        <dl class="facts-dl">
          <dt>Ветка</dt><dd class="mono">hub/T016/codex · dde331f → 9ab4c2e (WIP)</dd>
          <dt>Файлы</dt><dd><ul class="files"><li><span>core/compilers/hooks.ts</span><span><span class="add">+84</span> <span class="del">−12</span></span></li><li><span>core/compilers/hooks.test.ts</span><span><span class="add">+41</span></span></li></ul></dd>
          <dt>Тесты</dt><dd><span class="chip chip-err">1 падает</span> <span class="mono t-meta">SessionStart keeps PLUGIN_ROOT</span></dd>
        </dl>
        <div class="summary">
          <h4>Цель</h4><p>Переносить хуки Claude в формат Codex и помечать статус: как есть, с изменениями, не переносится.</p>
          <h4>Сделано</h4><p>События SessionStart, Stop и SubagentStop переносятся, diff показывается до записи.</p>
          <h4>На чём остановились</h4><p>Замена <span class="mono">${"${CLAUDE_PLUGIN_ROOT}"}</span> на <span class="mono">${"${PLUGIN_ROOT}"}</span> ломает тест запуска.</p>
          <h4>Следующие шаги</h4><ol><li>Исправить подстановку пути в компиляторе.</li><li>Прогнать тест хуков.</li><li>Пометить PreToolUse как «не проверено».</li></ol>
          <h4>Открытый вопрос</h4><p>Поддерживает ли Codex событие PreToolUse — не проверено.</p>
        </div>
        <p class="t-meta by">Смысловую часть написал Claude Haiku 5.5 · факты собраны кодом</p>
      </section>`;
    const propose = `<section class="propose" aria-labelledby="prop-title">
        <h2 class="t-section" id="prop-title">Кто продолжит</h2>
        <div class="next" style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="agent-badge">${av("claude")}Claude Sonnet 5.5 · medium</span>
          <label class="t-meta" for="agent-sel">или</label>
          <select class="select" id="agent-sel" data-testid="agent-select"><option>Claude Sonnet 5.5 · medium</option><option>Claude Sonnet 5.5 · high</option><option>Claude Opus 5.5 · high</option><option>Подождать Codex</option></select></div>
        <p class="muted" style="margin:12px 0 0">Почему: реализация по готовой спецификации; у Claude свободно 62% окна. Если тест упадёт дважды — повышу до high.</p>
        <div class="est"><span class="chip chip-line">0,4–1,8 млн токенов</span><span class="chip chip-line">≈ 1–3 $ API-экв.</span><span class="chip chip-warn">уверенность низкая</span></div>
        <div class="actions"><button class="btn btn-primary" type="button">Передать и запустить</button><button class="btn btn-glass" type="button">Подождать сброса · 2 д 4 ч</button></div>
      </section>`;
    const tl = [
      ["14:02:11", "acc", "Старт · Codex gpt-6.1-sol · high"],
      ["14:18:40", "ok", "Тест SessionStart зелёный"],
      ["14:27:03", "", "Изменена подстановка пути"],
      ["14:29:55", "err", "Тест упал: SessionStart keeps PLUGIN_ROOT"],
      ["14:31:09", "warn", "Лимит 95% → остановка"],
      ["14:31:12", "", "WIP-коммит 9ab4c2e"],
      ["14:31:20", "acc", "Карточка передачи собрана"],
    ];
    const timeline = `<section class="card plane" aria-labelledby="tl-title"><div class="section-head"><h2 class="t-section" id="tl-title">Что происходило</h2><span class="t-meta">7 из 214 событий</span></div>
      <ol class="timeline">${tl.map(([t, m, s]) => `<li><time>${t}</time><span class="mark ${m}"></span><span>${s}</span></li>`).join("")}</ol></section>`;
    if (S.v === "a") return `<div class="wrap">${head}<div class="grid-task"><div>${propose}<div style="height:16px"></div>${card}</div><div>${timeline}</div></div></div>`;
    return `<div class="window plane">${head}${propose}<div style="height:16px"></div>${card}${timeline}</div>`;
  };

  // ---------- Toolkit ----------
  const compat = (c) => {
    const [st, note] = c;
    const cls = st === "native" ? "chip-ok" : "chip-info";
    const label = st === "native" ? "как есть" : "адаптация";
    return `<span class="chip ${cls}" title="${esc(note)}">${label}${note ? " · " + esc(note) : ""}</span>`;
  };
  const compatCell = (c) => `<span class="compat"><span class="chip ${c[0] === "native" ? "chip-ok" : "chip-info"}">${c[0] === "native" ? "как есть" : "адаптация"}</span>${c[1] ? `<span class="t-meta" title="${esc(c[1])}">${esc(c[1])}</span>` : ""}</span>`;
  const visibleTools = () => tools.filter((t) => S.tkFilter === "all" || (S.tkFilter === "mandatory" ? t.mandatory : !t.mandatory));
  const tkSummary = () => {
    const sel = tools.filter((t) => selected.has(t.id));
    const tok = sel.reduce((a, t) => a + t.tokens, 0);
    const adapt = sel.filter((t) => t.claude[0] !== "native" || t.codex[0] !== "native").length;
    const nolic = sel.filter((t) => t.lic === "не указана").length;
    return `<div class="stats"><span class="t-label">Выбрано ${sel.length} из ${tools.length}</span><span class="t-meta">+${tok.toLocaleString("ru-RU")} токенов на ход</span><span class="t-meta">${adapt} адаптации</span>${nolic ? `<span class="chip chip-warn">${nolic} без лицензии</span>` : ""}</div>
      <button class="btn btn-primary" type="button" data-act="open-diff" data-testid="toolkit-review">Проверить изменения</button>`;
  };
  const toolkit = () => {
    const counts = { all: tools.length, mandatory: tools.filter((t) => t.mandatory).length, proposed: tools.filter((t) => !t.mandatory).length };
    const pill = (k, label) => `<button class="pill" type="button" data-tk="${k}" aria-pressed="${S.tkFilter === k}">${label}<span class="n">${counts[k]}</span></button>`;
    const head = `<header class="head"><div><div class="ctx"><span class="t-meta">${project.name} · Этап 3 из 8</span></div><h1 class="t-page">Инструменты проекта</h1><p class="muted" style="margin:6px 0 0;max-width:64ch">Скаут подобрал по brief.md. Ничего не установится, пока вы не проверите изменения.</p></div></header>`;
    const bar = `<div class="tk-bar"><div class="pills glass" role="group" aria-label="Фильтр">${pill("all", "Все")}${pill("mandatory", "Обязательные")}${pill("proposed", "Предложенные")}</div><span class="t-meta">цена в токенах — описание в контексте на каждом ходу</span></div>`;
    const ctl = (t) => t.mandatory
      ? `<input class="check" type="checkbox" checked disabled aria-label="${esc(t.name)} — обязательный">`
      : `<input class="check" type="checkbox" data-tool="${t.id}" ${selected.has(t.id) ? "checked" : ""} aria-label="Включить ${esc(t.name)}">`;
    const riskChip = (t) => `<span class="chip ${t.risk[0] === "ok" ? "chip-line" : "chip-warn"}">${esc(t.risk[1])}</span>`;
    let body;
    if (S.v === "a") {
      body = `<div class="tk-table"><div class="tk-head"><span></span><span>Инструмент</span><span>Токенов/ход</span><span>Claude</span><span>Codex</span><span>Лицензия</span></div>
        ${visibleTools().map((t) => `<div class="tk-row plate">${ctl(t)}<div><div class="name">${esc(t.name)}<span class="chip chip-line">${t.kind}</span>${t.mandatory ? '<span class="chip chip-soft">обязательный</span>' : ""}</div><div class="why">${esc(t.why)}</div><div class="cells">${riskChip(t)}<span class="chip chip-line">${t.tokens} ток.</span>${compat(t.claude)}${compat(t.codex)}<span class="chip chip-line">${esc(t.lic)}</span></div></div>
          <span class="num c-tokens">${t.tokens.toLocaleString("ru-RU")}</span><span class="c-claude">${compatCell(t.claude)}</span><span class="c-codex">${compatCell(t.codex)}</span><span class="c-lic">${t.lic === "не указана" ? '<span class="chip chip-warn">не указана</span>' : esc(t.lic)}</span></div>`).join("")}</div>`;
    } else {
      body = `<div class="tk-cards">${visibleTools().map((t) => `<article class="tk-card plate"><div class="top"><div><div class="t-label">${esc(t.name)}</div><div class="t-meta">${t.kind}${t.mandatory ? " · обязательный" : ""}</div></div>
        <label class="switch"><input type="checkbox" ${t.mandatory ? "checked disabled" : `data-tool="${t.id}" ${selected.has(t.id) ? "checked" : ""}`} aria-label="Включить ${esc(t.name)}"><span></span></label></div>
        <p style="margin:0">${esc(t.why)}</p>
        <div class="meta"><span class="chip chip-line">${t.tokens.toLocaleString("ru-RU")} ток./ход</span><span class="chip chip-line">Claude</span>${compat(t.claude)}<span class="chip chip-line">Codex</span>${compat(t.codex)}<span class="chip ${t.lic === "не указана" ? "chip-warn" : "chip-line"}">${esc(t.lic)}</span>${riskChip(t)}</div></article>`).join("")}</div>`;
    }
    const sum = `<div class="sumbar glass" id="sumbar">${tkSummary()}</div>`;
    if (S.v === "a") return `<div class="wrap">${head}${bar}${body}${sum}</div>`;
    return `<div class="window plane">${head}${bar}${body}</div>${sum}`;
  };

  // ---------- Dialogs ----------
  const sheet = document.getElementById("sheet");
  let opener = null;
  const openSheet = (html, from) => {
    opener = from;
    sheet.innerHTML = `<div class="in">${html}</div>`;
    sheet.showModal();
    sheet.querySelector("[data-close]")?.focus();
  };
  sheet.addEventListener("close", () => { if (opener) { opener.focus(); opener = null; } });
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) sheet.close(); });
  const cardSheet = () => `<div class="bar"><div><div class="t-meta">Карточка передачи · собрана в 14:31</div><h2 class="t-entity" id="sheet-title"><span class="mono">T016</span> · Хуки → Codex</h2></div><button class="btn btn-glass" type="button" data-close aria-label="Закрыть">${I.close}</button></div>
    <dl class="facts-dl"><dt>Ветка</dt><dd class="mono">hub/T016/codex · 9ab4c2e (WIP)</dd><dt>Файлы</dt><dd>2 изменено · +125 −12</dd><dt>Тесты</dt><dd><span class="chip chip-err">1 падает</span></dd><dt>Дальше</dt><dd>Исправить подстановку пути → прогнать тест → пометить PreToolUse</dd></dl>
    <div class="foot"><button class="btn btn-glass" type="button" data-close>Закрыть</button><a class="btn btn-primary" href="${href({ screen: "task" })}">Открыть задачу</a></div>`;
  const diffSheet = () => {
    const sel = tools.filter((t) => selected.has(t.id));
    const lines = [];
    sel.forEach((t) => {
      if (t.kind === "MCP") {
        lines.push([".mcp.json", `+ сервер ${t.name}`]);
        lines.push([".codex/config.toml", `+ [mcp_servers.shadcn] · адаптация`]);
      } else {
        lines.push([`.claude/skills/${t.id}`, t.claude[0] === "native" ? "+ ссылка (junction)" : "+ ссылка · адаптация"]);
        lines.push([`.agents/skills/${t.id}`, "+ ссылка (junction)"]);
      }
    });
    lines.push(["hub.lock", `+ ${sel.length} записей с хэшами`]);
    return `<div class="bar"><div><div class="t-meta">Будет записано в проект · резервная копия до записи</div><h2 class="t-entity" id="sheet-title">Изменения: ${lines.length} файлов</h2></div><button class="btn btn-glass" type="button" data-close aria-label="Закрыть">${I.close}</button></div>
      <ul class="diff">${lines.map(([f, d]) => `<li class="plate"><code>${esc(f)}</code><span class="t-meta">${esc(d)}</span></li>`).join("")}</ul>
      <p class="t-meta" style="margin:14px 0 0">Глобальные папки ~/.claude и ~/.codex не меняются. Откат: hub undo.</p>
      <div class="foot"><button class="btn btn-glass" type="button" data-close>Отмена</button><button class="btn btn-primary" type="button" data-close>Подтвердить и записать</button></div>`;
  };

  // ---------- Render & events ----------
  const app = document.getElementById("app");
  const render = () => {
    const body = S.screen === "today" ? today() : S.screen === "task" ? task() : toolkit();
    app.innerHTML = `${S.v === "a" ? rail() : tablens()}${dock()}${study()}<main class="page">${body}</main>`;
  };
  app.addEventListener("click", (e) => {
    const t = e.target.closest("[data-scope],[data-tk],[data-act]");
    if (!t) return;
    if (t.dataset.scope) { S.scope = t.dataset.scope; render(); app.querySelector(`[data-scope="${S.scope}"]`)?.focus(); }
    else if (t.dataset.tk) { S.tkFilter = t.dataset.tk; render(); app.querySelector(`[data-tk="${S.tkFilter}"]`)?.focus(); }
    else if (t.dataset.act === "open-card") openSheet(cardSheet(), t);
    else if (t.dataset.act === "open-diff") openSheet(diffSheet(), t);
    else if (t.dataset.act === "study") { e.preventDefault(); t.closest(".study").classList.toggle("collapsed"); }
  });
  app.addEventListener("change", (e) => {
    const id = e.target.dataset.tool;
    if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id);
    document.getElementById("sumbar").innerHTML = tkSummary();
  });
  render();
})();
