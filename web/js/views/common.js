import { api, prefs } from '../api.js';
import { agentBadge, agentName, avatar, btn, chip, closeBtn, dialog, fmt, h, icon, meter, pills, toast } from '../ui.js';

export const go = (path) => { location.hash = '#' + path; };
const themeBtn = (t, ic, label) => h('button', { type: 'button', 'aria-pressed': String((prefs.get().theme || 'dark') === t), 'aria-label': label, title: label, onclick: () => { prefs.set({ theme: t }); render(); } }, icon(ic, 'sm'));
const accentBtn = (a, label) => h('button', { type: 'button', 'aria-pressed': String((prefs.get().accent || 'green') === a), 'aria-label': label, title: label, onclick: () => { prefs.set({ accent: a }); render(); } }, h('i.swatch.' + (a === 'green' ? 'g' : 'o')));
let render = () => {};
const syncBar = () => { document.querySelectorAll('.prefs button').forEach((b) => b.dispatchEvent(new Event('hub-refresh'))); };

export function prefsBar() {
  const box = h('div.prefs');
  const draw = () => {
    box.replaceChildren(
      h('div.glass', { role: 'group', 'aria-label': 'Тема' }, themeBtn('dark', 'moon', 'Тёмная тема'), themeBtn('light', 'sun', 'Светлая тема')),
      h('div.glass', { role: 'group', 'aria-label': 'Акцент' }, accentBtn('green', 'Зелёный акцент'), accentBtn('orange', 'Оранжевый акцент')),
    );
  };
  render = draw; draw();
  void syncBar;
  return box;
}

/** Page header: breadcrumb context, title, subtitle, actions. */
export function pageHead({ crumbs = [], title, sub, actions }) {
  return h('header.topbar', h('div',
    crumbs.length ? h('div.ctx', crumbs.flatMap((c, i) => [i ? icon('chev', 'sm') : null, c.href ? h('a', { href: '#' + c.href }, c.text) : h('span', c.text)])) : null,
    h('h1.t-display', title), sub ? h('p.sub', sub) : null),
  h('div.row-flex', actions || null, prefsBar()));
}

export function limitCard(a) {
  const l = a.limit;
  const used = l && !l.stale ? l.usedPercent : null;
  const left = used == null ? null : Math.max(0, 100 - Math.round(used));
  const risky = used != null && used >= 90;
  return h('section.plane.limit-card', { 'aria-label': 'Лимит ' + agentName(a.id) },
    h('div.row-flex', { style: { justifyContent: 'space-between' } }, agentBadge(a.id), l?.planType ? chip('тариф ' + l.planType, 'line') : null),
    h('div.big', left == null ? '—' : left + '%'),
    meter(left, risky),
    h('div.row-flex', { style: { justifyContent: 'space-between' } },
      h('span.t-meta', left == null ? (l?.stale ? 'лимит уже обновился, свежих данных нет' : 'остаток не известен') : `осталось на неделю${l.resetsAt ? ' · обновится ' + fmt.until(l.resetsAt) : ''}`),
      risky ? chip('почти исчерпан', 'warn') : l ? chip(l.source === 'codex-log' ? 'данные Codex' : l.source === 'manual' ? 'вписано вами' : 'из чата', 'line') : null));
}

export function sessionRow(s) {
  return h('a.row.plate', { href: '#/s/' + encodeURIComponent(s.id) },
    avatar(s.agent),
    h('div', h('div.title', h('span.clamp1', s.title || 'Без названия')), h('div.sub', `${s.project || 'без проекта'} · ${fmt.model(s.model)} · сообщений: ${s.msgCount}`)),
    h('div.right', h('span.t-meta', fmt.ago(s.endedAt || s.startedAt)), s.projectId && !s.parentId ? h('span.chip.chip-soft', 'Продолжить') : null));
}

const OUTCOME = { done: ['готово', 'ok'], limit: ['лимит', 'warn'], failed: ['ошибка', 'err'], stopped: ['остановлено', 'line'], interrupted: ['прервано', 'line'] };
export function outcomeChip(r) {
  if (r.live) return h('span.chip.chip-info', h('span.dot.live'), 'идёт');
  const [t, tone] = OUTCOME[r.outcome] || ['—', 'line'];
  return chip(t, tone);
}
export function runRow(r, href) {
  return h('a.row.plate', { href: href || '#/chat/' + r.id },
    avatar(r.agent),
    h('div', h('div.title', h('span.clamp1', (r.prompt || '').replace(/\s+/g, ' ').slice(0, 90) || 'Запуск')), h('div.sub', `${fmt.model(r.model)}${r.effort ? ' · ' + r.effort : ''}${r.branch ? ' · ' + r.branch : ''}`)),
    h('div.right', outcomeChip(r), h('span.t-meta', fmt.ago(r.startedAt))));
}

/** Thread = chain of runs linked by resumeOf / handoffOf. Returns threads newest-first. */
export function threadsOf(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const rootOf = (r) => { let c = r, n = 0; while ((c.resumeOf || c.handoffOf) && byId.has(c.resumeOf || c.handoffOf) && n++ < 50) c = byId.get(c.resumeOf || c.handoffOf); return c; };
  const m = new Map();
  for (const r of runs) { const root = rootOf(r); if (!m.has(root.id)) m.set(root.id, { id: root.id, root, runs: [] }); m.get(root.id).runs.push(r); }
  const out = [...m.values()].map((t) => { t.runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)); t.last = t.runs.at(-1); return t; });
  return out.sort((a, b) => (a.last.startedAt < b.last.startedAt ? 1 : -1));
}

export async function projectsList() { return api.get('/projects'); }
export const projectSelect = (projects, value, onchange) => {
  const s = h('select.select', { 'aria-label': 'Проект', onchange: (e) => onchange?.(Number(e.target.value)) },
    projects.map((p) => h('option', { value: p.id, selected: p.id === value }, p.slug)));
  return s;
};

/**
 * Plan dialog shared by every write: shows each file change from a dry-run plan, writes only after the user confirms.
 * `r` is a plan response ({changes, notes, items?}); `apply()` performs the approved POST and returns the apply result.
 */
export function planDialog({ title, r, apply, missing }) {
  const label = { create: 'создать', link: 'ссылка', update: 'изменить' };
  const changes = r.changes.map((c) => h('details.plate', { style: { padding: '10px 14px' } },
    h('summary', { style: { cursor: 'pointer', display: 'flex', gap: '10px', alignItems: 'center', listStyle: 'none' } }, chip(label[c.action] || c.action, c.action === 'update' ? 'warn' : 'ok'), h('span.mono', c.path), c.note ? h('span.t-meta', '· ' + c.note) : null),
    c.action === 'link' ? h('p.t-meta', { style: { marginTop: '8px' } }, 'Ссылка (junction) на ' + c.after) : h('pre', { style: { marginTop: '10px', maxHeight: '260px' } }, c.after)));
  const items = (r.items || []).map((i) => h('div.row-flex', chip(i.status === 'ok' ? 'ок' : i.status === 'hash-changed' ? 'изменён' : i.status === 'missing-source' ? 'нет источника' : 'нет в библиотеке', i.status === 'ok' ? 'ok' : 'warn'), h('span.mono', i.id), h('span.t-meta', i.detail)));
  dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', title), h('p.t-meta', 'Пока вы не подтвердите, ничего не записано. Перед записью делается резервная копия, откат — одной кнопкой.')), closeBtn()),
    r.notes?.length ? h('div.alert.warn', icon('alert'), h('div', r.notes.join(' · '))) : null,
    items.length ? h('div.stack', items) : null,
    r.changes.length ? h('div.stack', changes) : h('p', 'Изменений нет: всё уже в нужном состоянии.'),
    missing?.length ? h('p.t-meta', 'Нет в библиотеке (пропущено): ' + missing.join(', ')) : null,
    h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), r.changes.length ? btn('Подтвердить и записать', { kind: 'primary', onclick: async () => { try { const a = await apply(); document.getElementById('dlg').close(); toast(`Записано файлов: ${a.written}. Можно откатить.`, 'ok'); location.reload(); } catch { /* api shows the toast */ } } }) : null)), { wide: true });
}

// ---------- shared pieces for the start screen, models and settings ----------
export const EFFORT = [['', 'Авто'], ['low', 'Быстро'], ['medium', 'Обычно'], ['high', 'Глубоко'], ['xhigh', 'Очень глубоко'], ['max', 'Максимум']];
export const EFFORT_RU = { low: 'быстро', medium: 'обычно', high: 'глубоко', xhigh: 'очень глубоко', max: 'максимум' };
export const TASKS = [['implement', 'Писать код'], ['plan', 'Придумать план'], ['debug', 'Найти ошибку'], ['review', 'Проверить чужой код'], ['mechanical', 'Рутина: переименовать, поправить текст'], ['summary', 'Короткий пересказ']];
export const modelName = (guide, agent, id) => (guide.find((g) => g.agent === agent && (g.id === id || (id && id.includes(g.id))))?.name) || id || 'по умолчанию';

/** One agent: is it installed, is it signed in, and a button for the next step. */
export function agentCard(a, { onChange } = {}) {
  const name = a.id === 'codex' ? 'Codex' : 'Claude Code';
  const st = !a.installed ? ['Не установлен', 'err'] : a.auth?.loggedIn === true ? ['Подключён', 'ok'] : a.auth?.loggedIn === false ? ['Нужен вход', 'warn'] : ['Статус неизвестен', 'line'];
  const login = async () => { try { await api.post('/agents/login', { agent: a.id }); toast('Открыл окно терминала. Войдите там, потом нажмите «Проверить».', 'ok'); } catch { /* api shows the toast */ } };
  return h('div.agent-card.plate',
    avatar(a.id),
    h('div', h('div.title', name, chip(st[0], st[1])), h('div.sub', !a.installed ? (a.id === 'claude' ? 'Программа не найдена на этом компьютере. Установите Claude Code и вернитесь сюда.' : 'Программа не найдена на этом компьютере. Установите Codex и вернитесь сюда.') : a.auth?.loggedIn === true ? `${a.version || ''}${a.auth.how ? ' · вход: ' + a.auth.how : ''}` : a.auth?.loggedIn === false ? 'Без входа чат работать не будет. Войдите один раз в открывшемся окне.' : (a.version || ''))),
    h('div.row-flex', a.installed && a.auth?.loggedIn !== true ? btn('Войти', { kind: 'primary', onclick: login }) : null, a.installed ? btn('Проверить', { kind: 'glass', onclick: () => onChange?.() }) : null));
}

/** Native "choose folder" window; the chosen folder becomes a project. Returns the project id, or null if cancelled. */
export async function openFolder() {
  toast('Выберите папку в открывшемся окне (оно может быть за браузером)');
  const r = await api.post('/projects/pick');
  return r.cancelled ? null : r.id;
}

/** "Add project" dialog: the button opens the folder window, typing a path is the fallback. */
export function addProjectDialog(onAdded) {
  const input = h('input.input', { placeholder: 'или впишите путь: C:\Users\вы\Desktop\мой-проект', 'aria-label': 'Путь к папке' });
  const done = (id) => { document.getElementById('dlg').close(); onAdded(id); };
  const pick = async () => { try { const id = await openFolder(); if (id) done(id); } catch { /* api shows the toast */ } };
  const typed = async () => { if (!input.value.trim()) return; try { const r = await api.post('/projects', { path: input.value.trim() }); done(r.id); } catch { /* api shows the toast */ } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') typed(); });
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Добавить проект'), closeBtn()), h('p.muted', 'Проект — это папка с вашей работой. Hub ничего в ней не меняет, пока вы сами не подтвердите.'),
    btn('Открыть папку…', { kind: 'primary', icon: 'folder', onclick: pick }), h('div.row-flex', input, btn('Добавить', { kind: 'glass', onclick: typed }))));
}

/** One line about an agent's limit: how much is left and when it resets. */
export function limitLine(a) {
  const l = a.limit; const used = l && !l.stale ? l.usedPercent : null;
  if (used == null) return h('div.t-meta', a.id === 'claude' ? 'Остаток лимита Claude не определяется сам: впишите его на странице «Модели».' : 'Остаток лимита появится после первой сессии Codex.');
  const left = Math.max(0, 100 - Math.round(used));
  return h('div.stack', { style: { gap: '6px' } }, h('div.t-meta', `Осталось ${left}% недельного лимита${l.resetsAt ? ' · сброс ' + fmt.until(l.resetsAt) : ''}`), meter(left, left <= 10));
}

const TYPES = [['web-saas', 'Сайт или веб-сервис'], ['mobile-app', 'Мобильное приложение'], ['automation', 'Бот, автоматизация, агенты'], ['design-study', 'Дизайн-исследование']];

/**
 * "Link Claude and Codex to this project": creates ONE set of rules (AGENTS.md) and the same skills for both agents.
 * Shows every file first; nothing is written until the user confirms.
 */
export function linkProject(projectId, onDone) {
  const sel = h('select.select', { 'aria-label': 'Тип проекта' }, TYPES.map(([v, t]) => h('option', { value: v }, t)));
  const show = async () => {
    let r; try { r = await api.post('/init/plan', { projectId, type: sel.value }); } catch { return; }
    planDialog({ title: 'Связать Claude и Codex с проектом', r, missing: r.missing, apply: async () => { const a = await api.post('/init/apply', { projectId, type: sel.value, approved: true }); onDone?.(); return a; } });
  };
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Связать Claude и Codex'), closeBtn()),
    h('p.muted', 'Сейчас у каждого агента свои правила и свои скиллы. После связки в проекте появится один файл правил AGENTS.md и одинаковый набор скиллов для обоих.'),
    h('div.field', h('label', 'Что за проект'), sel), h('p.t-meta', 'От типа зависят правила работы и стартовый набор скиллов. Ничего не запишется, пока вы не подтвердите список файлов.'),
    h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), btn('Показать, что изменится', { kind: 'primary', onclick: () => { document.getElementById('dlg').close(); show(); } }))));
}

/** CLI model name: Claude takes aliases (sonnet, opus), Codex takes the full id. */
/** "≈ 12–40% недельного лимита": never above 100, and honest when a task could eat most of the week. */
export const pctText = (p) => (!p ? '' : p.low >= 90 ? 'может съесть почти весь недельный лимит' : p.high > 100 ? `≈ ${p.low}% недельного лимита и больше` : `≈ ${p.low}–${p.high}% недельного лимита`);

export const shortModel = (agent, model) => (agent === 'claude' ? String(model || '').replace(/^claude-/, '').replace(/-\d.*$/, '') : model);

export const DEPTHS = [['strict', 'Строго'], ['normal', 'Обычно'], ['deep', 'Глубоко']];
/** "Как работаем": one pill per work mode, a plain hint under it, a warning when the mode cannot start here, depth pills for the autopilot only. */
export function workModePicker(modes, cur, onpick, depth, ondepth) {
  const m = modes.find((x) => x.id === cur) || modes[0];
  if (!m) return h('div');
  const why = m.unavailable ? (/\((.+)\)$/.exec(m.unavailable)?.[1] ?? m.unavailable) : null;
  return h('div.stack', { style: { gap: '8px' } },
    pills(modes.map((x) => [x.id, x.title]), m.id, onpick, 'Как работаем'),
    h('span.t-meta', m.hint),
    why ? chip('Недоступно: ' + why, 'warn', m.unavailable) : null,
    m.id === 'autopilot' ? pills(DEPTHS, depth, ondepth, 'Глубина автопилота') : null);
}
