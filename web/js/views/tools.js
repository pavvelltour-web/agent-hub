import { api, qs } from '../api.js';
import { agentBadge, btn, chip, closeBtn, copy, debounce, dialog, empty, fmt, h, icon, meter, pills, sectionHead, toast } from '../ui.js';
import { linkProject, planDialog } from './common.js';

const STATE = { on: 'Включён', 'name-only': 'Только название', off: 'Выключен' };
const KIND = { skill: 'скилл', mcp: 'MCP', plugin: 'плагин', agent: 'агент', command: 'команда', hook: 'хук' };
const SCAN = { LOW: ['ok', 'проверен: риск низкий'], MEDIUM: ['warn', 'проверен: риск средний'], HIGH: ['err', 'проверен: риск высокий'], CRITICAL: ['err', 'проверен: риск критичный'] };
const tokChip = (n, on = true) => chip(`${n} ток.`, on ? 'line' : 'ok', 'Столько токенов агент тратит на описание при каждом вашем сообщении');

/**
 * One place for everything a project loads: skills, plugins, MCP. Numbers are what each agent reads on EVERY message;
 * the controls change only this project; new tools go to the hub library first and cost nothing until connected.
 */
export async function toolsPanel({ projectId, initialTab }) {
  const [au, lib, project, oh] = await Promise.all([api.get('/loading' + qs({ project: projectId })), api.get('/library' + qs({ project: projectId })), api.get('/projects/' + projectId), api.get('/overhead' + qs({ project: projectId }), true).catch(() => null)]);
  let tab = initialTab || 'skills', q = '';
  const pendingSkills = new Map(), pendingPlugins = new Map();   // name/id -> desired state
  const summary = h('div.grid-2'), body = h('div.stack'), bar = h('div.pending-bar.glass', { hidden: true });

  // ---- rows merged per tool (one skill can load in both agents)
  const skills = new Map(), plugins = new Map();
  for (const r of au.rows) {
    if (r.kind === 'skill') { const k = r.name; const x = skills.get(k) || { name: k, id: r.id, detail: r.detail, agents: [], tokens: {}, base: {}, origin: r.origin, switchable: r.switchable, state: r.state }; x.agents.push(r.agent); x.tokens[r.agent] = r.tokens; x.base[r.agent] = r.baseTokens; if (r.origin === 'user') x.origin = 'user'; x.switchable = x.switchable || r.switchable; skills.set(k, x); }
    if (r.kind === 'plugin') { const x = plugins.get(r.id) || { id: r.id, name: r.name, detail: r.detail, agents: [], base: {}, tokens: {}, state: r.state, suggest: !!r.suggest }; x.agents.push(r.agent); x.base[r.agent] = r.baseTokens; x.tokens[r.agent] = r.tokens; plugins.set(r.id, x); }
  }
  const cost = (x) => Math.max(0, ...Object.values(x.base));
  const stateOf = (x, map) => map.get(x.name || x.id) ?? x.state;

  // ---- projected numbers: current state + what the user has toggled but not applied
  const projected = (agent) => {
    let now = 0;
    for (const x of skills.values()) if (x.agents.includes(agent)) { const st = stateOf(x, pendingSkills); now += st === 'on' ? x.base[agent] || 0 : st === 'name-only' ? Math.ceil(x.name.length / 4) + 2 : 0; }
    for (const x of plugins.values()) if (x.agents.includes(agent)) now += (pendingPlugins.get(x.id) ?? x.state) === 'off' ? 0 : x.base[agent] || 0;
    const cap = au.totals[agent].cap;
    return cap ? Math.min(now, cap) : now;
  };
  const drawSummary = () => summary.replaceChildren(...['claude', 'codex'].map((a) => {
    const t = au.totals[a], now = projected(a), base = t.baseline;
    return h('section.plane.limit-card', { 'aria-label': 'Расход на описания инструментов, ' + a },
      h('div.row-flex', { style: { justifyContent: 'space-between' } }, agentBadge(a), h('span.t-meta', 'читает на каждое сообщение')),
      h('div.big', `${fmt.tok(now)} ток.`), meter(base ? Math.round(100 * now / base) : 0, false),
      oh?.[a]?.n ? h('span.t-meta', `Измерено в ваших разговорах: ${a === 'claude' ? 'Claude' : 'Codex'} начинает с ≈ ${fmt.tok(oh[a].median)} ток. (разговоров: ${oh[a].n}). Сюда входят и описания, и системные инструкции.`) : null,
      h('span.t-meta', base === now ? (t.cap && base >= t.cap ? 'Codex сам урезает список до ≈ 2 тыс.: лишние скиллы вытесняют нужные.' : 'Это описания всех включённых скиллов и плагинов.') : `было ${fmt.tok(base)} → станет ${fmt.tok(now)} (−${Math.round(100 * (base - now) / Math.max(1, base))}%)`));
  }));

  // ---- pending bar
  const pendingCount = () => pendingSkills.size + pendingPlugins.size;
  const drawBar = () => {
    bar.hidden = pendingCount() === 0;
    bar.replaceChildren(h('b', `Изменений: ${pendingCount()}`), h('span.t-meta', 'только в этом проекте'),
      h('div.row-flex', btn('Отменить', { kind: 'glass', onclick: () => { pendingSkills.clear(); pendingPlugins.clear(); redraw(); } }), btn('Посмотреть и применить', { kind: 'primary', icon: 'check', onclick: plan })));
  };
  const plan = async () => {
    const req = { projectId, skills: Object.fromEntries(pendingSkills), plugins: Object.fromEntries([...pendingPlugins].map(([k, v]) => [k, v !== 'off'])) };
    let r; try { r = await api.post('/profile/plan', req); } catch { return; }
    planDialog({ title: 'Инструменты этого проекта', r, apply: () => api.post('/profile/apply', { ...req, approved: true }) });
  };
  const redraw = () => { drawSummary(); drawBar(); drawBody(); };

  // ---- per-row controls
  const seg = (current, options, onpick, label) => pills(options.map((k) => [k, STATE[k]]), current, onpick, label);
  const agentChips = (x) => h('span.row-flex', { style: { gap: '4px' } }, x.agents.map((a) => chip(a === 'claude' ? 'Claude' : 'Codex', 'line')));
  const setSkill = (x, st) => { if (st === x.state) pendingSkills.delete(x.name); else pendingSkills.set(x.name, st); redraw(); };

  const skillsView = () => {
    const rows = [...skills.values()].filter((x) => !q || (x.name + x.detail).toLowerCase().includes(q)).sort((a, b) => cost(b) - cost(a));
    const inProject = rows.filter((x) => x.origin === 'project'), global = rows.filter((x) => x.origin === 'user');
    const row = (x) => {
      const st = stateOf(x, pendingSkills);
      const opts = x.agents.includes('claude') ? ['on', 'name-only', 'off'] : ['on', 'off'];
      return h('div.tool-row.plate' + (pendingSkills.has(x.name) ? '.changed' : ''),
        h('div.grow', h('div.title', h('span.clamp1', x.name), agentChips(x)), h('div.sub.clamp1', x.detail)),
        tokChip(cost(x), st === 'on'),
        x.switchable ? seg(st, opts, (k) => setSkill(x, k), 'Состояние ' + x.name) : btn('Убрать из проекта', { kind: 'glass', onclick: () => removeFromProject(x) }));
    };
    return h('div.stack',
      inProject.length ? h('section.group', sectionHead('Подключены к этому проекту'), h('div.list', inProject.map(row))) : null,
      h('section.group', sectionHead('Установлены на весь компьютер', h('span.t-meta', 'агент читает их в каждом проекте')),
        h('p.t-meta', '«Только название» оставляет одно имя: скилл почти ничего не стоит, но его можно вызвать командой /имя. «Выключен» убирает его совсем. Меняется только этот проект, сам скилл не удаляется.'),
        global.length ? h('div.list', global.map(row)) : empty('Таких скиллов нет', 'Всё, что вы добавляете через hub, лежит в его библиотеке и ничего не стоит, пока вы не подключите это к проекту.')));
  };

  const pluginsView = () => {
    const rows = [...plugins.values()].filter((x) => !q || (x.name + x.id).toLowerCase().includes(q)).sort((a, b) => cost(b) - cost(a));
    const paid = rows.filter((x) => cost(x) > 0), free = rows.length - paid.length;
    return h('div.stack',
      h('p.t-meta', 'Плагин — это набор скиллов, команд и MCP одним пакетом. Описания его скиллов агент читает на каждое сообщение, поэтому именно плагины дают основной расход. Выключение действует только в этом проекте.'),
      paid.length ? h('div.list', paid.map((x) => {
        const st = pendingPlugins.get(x.id) ?? x.state;
        return h('div.tool-row.plate' + (pendingPlugins.has(x.id) ? '.changed' : ''),
          h('div.grow', h('div.title', h('span.clamp1', x.name), x.suggest ? chip('похоже, здесь не нужен', 'warn') : null, agentChips(x)), h('div.sub.clamp1', x.detail.replace(/(\d+) skills/, 'скиллов внутри: $1'))),
          tokChip(cost(x), st === 'on'),
          seg(st, ['on', 'off'], (k) => { if (k === x.state) pendingPlugins.delete(x.id); else pendingPlugins.set(x.id, k); redraw(); }, 'Плагин ' + x.name));
      })) : empty('Включённых плагинов со скиллами нет'),
      free ? h('p.t-meta', `Ещё плагинов без скиллов: ${free}. Они не тратят токены на описания, поэтому не показаны.`) : null);
  };

  const mcpView = () => {
    const mine = au.rows.filter((r) => r.kind === 'mcp');
    const libMcp = lib.entries.filter((e) => e.kind === 'mcp' && !mine.some((r) => r.name === e.id.replace(/^mcp\//, '')));
    return h('div.stack',
      h('p.t-meta', 'MCP-сервер даёт агенту новые действия: открыть браузер, прочитать Figma, сходить в базу. Подключённые здесь работают только в этом проекте. Claude подгружает их описания по запросу, поэтому точную цену hub не показывает.'),
      mine.length ? h('div.list', mine.map((r) => h('div.tool-row.plate', h('div.grow', h('div.title', r.name, chip(r.agent === 'claude' ? 'Claude' : 'Codex', 'line')), h('div.sub', r.detail === '.mcp.json' ? 'настроен для Claude в .mcp.json' : 'настроен для Codex в config.toml'))))) : empty('В проекте нет MCP-серверов'),
      h('p.t-meta', 'MCP, которые вы подключили в Claude для всех проектов сразу, здесь не видны: включить или выключить их для проекта можно в самом Claude командой /mcp.'),
      h('section.group', sectionHead('Можно подключить'), libMcp.length ? h('div.list', libMcp.map((e) => h('div.tool-row.plate', h('div.grow', h('div.title', e.title, e.sourceVerified ? null : chip('источник не проверен', 'warn')), h('div.sub.clamp1', e.description)), btn('Подключить', { kind: 'glass', onclick: () => connect(e) })))) : empty('Других MCP нет', 'Найдите нужный на вкладке «Найти».')));
  };

  // ---- actions on the project (init plan with extra/remove, reusing the plan dialog)
  const initPlan = async (extra, remove, title) => {
    const req = { projectId, extra, remove };
    let r; try { r = await api.post('/init/plan', req); } catch { return; }
    planDialog({ title, r, missing: r.missing, apply: () => api.post('/init/apply', { ...req, approved: true }) });
  };
  const undo = async () => { const b = await api.get('/backups' + qs({ project: projectId })); if (!b.length) return toast('Нечего отменять'); await api.post('/undo', { projectId, backupId: b.at(-1) }); toast('Последнее изменение отменено', 'ok'); location.reload(); };
  const setup = project.hub
    ? h('div.row-flex', { style: { justifyContent: 'flex-end' } }, btn('Отменить последнее изменение', { kind: 'glass', onclick: undo }))
    : h('div.alert.info', icon('info'), h('div.stack', { style: { flex: 1 } }, h('b', 'Claude и Codex пока не связаны с этой папкой'), h('span', 'После связки у обоих будут одни правила и один набор скиллов. Ниже уже можно приглушить лишнее.'), h('div', btn('Связать Claude и Codex', { kind: 'primary', onclick: () => linkProject(projectId, () => location.reload()) }))));
  const connect = (e) => initPlan([e.id], [], `Подключить «${e.title}» к проекту`);
  const removeFromProject = (x) => initPlan([], [x.id], `Убрать «${x.name}» из проекта`);

  const find = findPanel({ projectId, inProjectIds: new Set((project.toolkit?.selected || []).map((s) => s.id)), onConnect: connect });

  const tabs = h('div'), searchBox = h('div');
  function drawBody() {
    tabs.replaceChildren(pills([['skills', 'Скиллы', skills.size], ['plugins', 'Плагины', [...plugins.values()].filter((x) => cost(x) > 0).length], ['mcp', 'MCP', au.rows.filter((r) => r.kind === 'mcp').length], ['find', 'Найти']], tab, (k) => { tab = k; redraw(); }, 'Разделы инструментов'));
    if (tab === 'find') { searchBox.replaceChildren(); body.replaceChildren(find.node); find.open(); return; }
    const input = h('input.input', { type: 'search', placeholder: 'Фильтр по названию', 'aria-label': 'Фильтр', value: q });
    input.addEventListener('input', debounce(() => { q = input.value.trim().toLowerCase(); const keep = input.selectionStart; drawList(); input.focus(); input.setSelectionRange(keep, keep); }, 150));
    searchBox.replaceChildren(h('div.search', { style: { maxWidth: '420px' } }, icon('search', 'sm'), input));
    drawList();
  }
  function drawList() { body.replaceChildren(tab === 'skills' ? skillsView() : tab === 'plugins' ? pluginsView() : mcpView()); }

  const keepOnly = async () => {
    const sc = await api.get('/scout' + qs({ project: projectId, type: project.hub?.project?.type || 'web-saas' }), true).catch(() => []);
    const keep = new Set([...(project.toolkit?.selected || []).map((s) => s.id.replace(/^skill\//, '')), ...sc.slice(0, 8).map((s) => s.id.replace(/^skill\//, ''))]);
    let n = 0;
    for (const x of skills.values()) if (x.switchable && x.state === 'on' && !keep.has(x.name)) { pendingSkills.set(x.name, x.agents.includes('claude') ? 'name-only' : 'off'); n++; }
    for (const x of plugins.values()) if (x.state === 'on' && x.suggest && cost(x) > 0) { pendingPlugins.set(x.id, 'off'); n++; }
    toast(n ? `Предлагаю изменений: ${n}. Посмотрите их и нажмите «Посмотреть и применить».` : 'Лишнего не нашлось', n ? 'ok' : '');
    if (tab === 'find') tab = 'plugins';
    redraw();
  };
  const suggest = btn('Убрать лишнее', { kind: 'glass', icon: 'spark', title: 'Оставит то, что нужно этому типу проекта; остальные скиллы станут «только название», ненужные плагины выключатся. Ничего не меняется без вашего подтверждения.', onclick: keepOnly });

  redraw();
  const graph = graphCard(projectId);
  return { node: h('div.stack', setup, graph.node, summary, h('div.row-flex', { style: { justifyContent: 'space-between' } }, tabs, suggest), searchBox, body, bar), cleanup() { graph.cleanup(); } };
}

/**
 * The project graph (graphify): built / stale / missing, and the button that builds or refreshes it. The update runs in the background on the
 * server; this card polls while it runs. Nothing starts without the confirmation: the tool reads the project and writes only `graphify-out`.
 */
function graphCard(projectId) {
  const box = h('section.plane.card.stack', { 'aria-label': 'Граф проекта' });
  let st = null, timer = null, wasRunning = false;
  const load = async () => {
    try { st = await api.get('/graph' + qs({ project: projectId }), true); } catch { st = null; }
    if (wasRunning && st && !st.running) toast(st.last?.ok ? 'Граф обновлён' : 'Граф не обновился: ' + (st.last?.message || 'неизвестная ошибка'), st.last?.ok ? 'ok' : 'err');
    wasRunning = !!st?.running;
    clearTimeout(timer);
    if (st?.running) timer = setTimeout(load, 1500);
    draw();
  };
  const confirmRun = () => {
    const dlg = dialog(h('div.stack',
      h('div.bar', h('h2.t-title', 'Построить граф проекта'), closeBtn()),
      h('p', 'Hub запустит graphify в папке проекта. Он прочитает файлы проекта, кроме перечисленных в .graphifyignore, и запишет только папку graphify-out. Модель не вызывается, сеть не нужна.'),
      h('p.t-meta', 'Изменения в документах и картинках граф подхватит агент командой /graphify . --update.'),
      h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => dlg.close() }),
        btn('Запустить', { kind: 'primary', onclick: async () => { dlg.close(); try { await api.post('/graph/update', { projectId, approved: true }); } catch { return; } toast('Граф строится в фоне', 'ok'); wasRunning = true; await load(); } }))));
  };
  function draw() {
    if (!st) { box.replaceChildren(h('div.t-heading', 'Граф проекта'), h('p.t-meta', 'Не удалось получить состояние графа.')); return; }
    const [tone, label] = !st.available ? ['line', 'недоступен'] : st.running ? ['warn', 'строится'] : st.state === 'built' ? ['ok', 'построен'] : st.state === 'stale' ? ['warn', 'устарел'] : ['line', 'не построен'];
    const text = !st.available ? 'graphify не найден на этом компьютере. Без него граф построить нельзя.'
      : st.running ? 'Идёт построение. Можно заняться другим: оно работает в фоне.'
      : st.state === 'missing' ? 'Пока графа нет: агент тратит токены на перебор файлов. С графом он спрашивает карту и открывает только нужные места.'
      : st.state === 'stale' ? `Файлов изменилось после построения: ${st.staleFiles}${st.example ? ` (например, ${st.example})` : ''}. Граф ещё полезен, но может не знать о новом коде.`
      : `Построен ${fmt.date(st.builtAt)}. Агенты читают граф, а не перебирают репозиторий.`;
    const failed = !st.running && st.last && !st.last.ok;
    box.replaceChildren(
      h('div.row-flex', { style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, h('div.row-flex', h('div.t-heading', 'Граф проекта'), chip(label, tone)),
        btn(st.state === 'missing' ? 'Построить граф проекта' : 'Обновить граф', { kind: st.state === 'built' ? 'glass' : 'primary', icon: 'spark', disabled: !st.available || st.running, onclick: confirmRun })),
      h('p', text),
      failed ? h('div.alert.warn', icon('alert'), h('div', `Последняя попытка не удалась: ${st.last.message}`)) : null);
  }
  load();
  return { node: box, cleanup() { clearTimeout(timer); } };
}

const EXAMPLES = ['тесты для сайта', 'работа с PDF', 'дизайн интерфейса', 'база данных', 'деплой', 'Telegram-бот'];
const SOURCES = {
  library: ['Уже есть у вас', 'Скиллы и MCP на этом компьютере и в библиотеке hub. Подключаются к проекту одной кнопкой.'],
  aitmpl: ['Каталог aitmpl.com', 'Открытый каталог: около 900 скиллов и 100 MCP. Перед добавлением hub покажет весь текст и проверку безопасности каталога. Без запроса показывает самые популярные.'],
  github: ['GitHub', 'Поиск репозиториев. Hub покажет команду для скачивания, сам ничего не качает. Нужна программа gh с выполненным входом.'],
};

/**
 * Search for new tools in plain words. Used inside a project (results can be connected) and on the global Tools page.
 * Outside items are never installed silently: preview → add to the hub library → connect to a project.
 */
export function findPanel({ projectId, inProjectIds = new Set(), onConnect } = {}) {
  let source = 'aitmpl', q = '', loaded = false;
  const results = h('div.stack'), srcBox = h('div'), hint = h('p.t-meta');
  const input = h('input.input', { type: 'search', placeholder: 'Что нужно сделать? Например: тесты для сайта', 'aria-label': 'Что нужно найти', style: { flex: 1, minWidth: '220px' } });

  const preview = async (item) => {
    let pv; try { pv = await api.get('/remote/preview' + qs({ id: item.id })); } catch { return; }
    const [tone, label] = SCAN[pv.scan?.severity] || ['line', 'каталог его не проверял'];
    const add = async () => {
      let r; try { r = await api.post('/remote/install/plan', { id: item.id }); } catch { return; }
      planDialog({ title: `Добавить «${pv.name}» в библиотеку hub`, r, apply: () => api.post('/remote/install/apply', { id: item.id, digest: r.digest, approved: true }) });
    };
    dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', pv.name), h('div.row-flex', { style: { marginTop: '6px' } }, chip(KIND[pv.kind] || pv.kind, 'line'), chip(pv.license === 'unknown' ? 'лицензия не указана' : pv.license, pv.license === 'unknown' ? 'warn' : 'line'), chip(label, tone), pv.runsCode ? chip('внутри есть скрипты', 'warn') : null)), closeBtn()),
      pv.blocked ? h('div.alert.err', icon('alert'), h('div', 'Не добавляю: ' + blockedRu(pv.blocked))) : h('div.alert.info', icon('info'), h('div', 'Сначала прочитайте текст ниже. Hub положит это в свою библиотеку, а не в папки агентов: пока вы не подключите к проекту, расход нулевой.')),
      pv.files.length > 1 ? h('p.t-meta', 'Файлы: ' + pv.files.map((f) => f.path).join(', ')) : null, h('pre', { style: { maxHeight: '320px' } }, pv.text),
      h('div.foot', btn('Закрыть', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), pv.blocked ? null : btn('Добавить в библиотеку', { kind: 'primary', onclick: () => { document.getElementById('dlg').close(); add(); } }))), { wide: true });
  };
  const row = (x) => {
    const outside = x.id.startsWith('aitmpl/') || x.id.startsWith('github/');
    const action = /^aitmpl\/(skills|mcps)\//.test(x.id) ? btn('Посмотреть', { kind: 'glass', onclick: () => preview(x) })
      : outside ? (x.installCommand ? btn('Скопировать команду', { kind: 'glass', icon: 'copy', onclick: () => copy(x.installCommand) }) : null)
        : !projectId ? chip('есть у вас', 'ok') : inProjectIds.has(x.id) ? chip('уже подключён', 'ok') : btn('Подключить к проекту', { kind: 'glass', onclick: () => onConnect?.(x) });
    const reserve = !outside && x.scope === 'hub';
    return h('div.tool-row.plate', { style: { alignItems: 'flex-start' } },
      h('div.grow', h('div.title', h('span.clamp1', x.title), chip(KIND[x.kind] || x.kind, 'line'), x.scan ? chip(SCAN[x.scan]?.[1] || x.scan, SCAN[x.scan]?.[0] || 'line') : null, reserve ? chip('в запасе, 0 ток.', 'ok') : null),
        h('div.sub', { style: { whiteSpace: 'normal' } }, x.description || ''), x.reasons?.length ? h('div.t-meta', x.reasons.join(' · ')) : null),
      chip(x.license === 'unknown' ? 'лицензия не указана' : x.license, x.license === 'unknown' ? 'warn' : 'line'), action);
  };
  async function search() {
    loaded = true;
    if (source === 'github' && !q) { results.replaceChildren(empty('Напишите запрос', 'Например: «claude skills design» или «mcp postgres».')); return; }
    results.replaceChildren(h('div.skeleton', { style: { height: '56px' } }));
    try {
      const items = source === 'library' ? (await api.get('/scout' + qs({ project: projectId, brief: q }), true)).slice(0, 30) : (await api.get('/scout/remote' + qs({ source, q }), true)).items;
      results.replaceChildren(...(items.length ? [h('p.t-meta', q ? `Найдено: ${items.length}` : 'Самые популярные:'), ...items.map(row)] : [empty('Ничего не нашлось', 'Попробуйте сказать иначе или выбрать другой источник.')]));
    } catch { results.replaceChildren(h('div.alert.warn', icon('alert'), h('div', source === 'github' ? 'GitHub не ответил. Нужна программа gh и вход в неё (gh auth login), или нет интернета.' : 'Каталог не ответил. Проверьте интернет.'))); }
  }
  const drawSrc = () => { srcBox.replaceChildren(pills(Object.entries(SOURCES).map(([k, [t]]) => [k, t]), source, (k) => { source = k; drawSrc(); search(); }, 'Где искать')); hint.textContent = SOURCES[source][1]; };
  const run = () => { q = input.value.trim(); search(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  drawSrc();
  const node = h('div.stack',
    h('div.plane.card.stack', h('h3.t-heading', 'Найти новый инструмент'), h('p.muted', 'Опишите своими словами, что нужно сделать. Hub найдёт подходящие скиллы и MCP и покажет, сколько они будут стоить и насколько им можно доверять.'),
      srcBox, hint, h('div.row-flex', input, btn('Искать', { kind: 'primary', icon: 'search', onclick: run })),
      h('div.row-flex', h('span.t-meta', 'Например:'), EXAMPLES.map((e) => h('button.chip.chip-line', { type: 'button', style: { cursor: 'pointer' }, onclick: () => { input.value = e; run(); } }, e)))),
    results);
  return { node, open: () => { if (!loaded) search(); } };
}

const blockedRu = (m) => m
  .replace(/^the catalog's own scan \((\w+)\) rated it (\w+); read it on GitHub first$/, 'проверка каталога ($1) оценила риск как $2. Прочитайте исходники на GitHub сами.')
  .replace(/^a skill with this name already exists in your library$/, 'скилл с таким именем у вас уже есть.')
  .replace(/^an MCP with this name already exists in your library$/, 'MCP с таким именем у вас уже есть.')
  .replace(/^file (.+) is binary or the skill is too large$/, 'внутри бинарный файл ($1) или скилл слишком большой.')
  .replace(/^unsafe file path in the catalog: (.+)$/, 'в каталоге подозрительный путь к файлу: $1.')
  .replace(/^too many files .*$/, 'слишком много файлов.');
