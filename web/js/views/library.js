import { api } from '../api.js';
import { btn, chip, closeBtn, debounce, dialog, empty, fmt, h, icon, pills } from '../ui.js';
import { pageHead } from './common.js';
import { findPanel } from './tools.js';

const KIND = { skill: 'скилл', mcp: 'MCP', plugin: 'плагин', agent: 'агент', command: 'команда', hook: 'хук' };
const where = (e) => (e.scope === 'hub' && !(e.visibleTo || []).length ? ['в запасе', 'ok'] : (e.globalVisibleTo || []).length ? [(e.globalVisibleTo || []).map((a) => (a === 'claude' ? 'Claude' : 'Codex')).join(' + ') + ', везде', 'line'] : ['в проекте', 'line']);

export default async function view() {
  const lib = await api.get('/library');
  const skills = lib.entries.filter((e) => e.kind === 'skill'), mcps = lib.entries.filter((e) => e.kind === 'mcp');
  const plugins = lib.plugins.filter((p) => p.enabled).sort((a, b) => b.tokens - a.tokens);
  const plugTok = (a) => plugins.filter((p) => p.agents.includes(a)).reduce((x, p) => x + p.tokens, 0);
  const claude = lib.tax.claude.tokens + plugTok('claude'), codex = lib.tax.codex.tokens + plugTok('codex');

  const stat = (title, big, text) => h('section.plane.card.stack', { style: { gap: '6px' } }, h('span.t-meta', title), h('div.big', big), h('p.t-meta', text));
  const top = h('div.grid-3',
    stat('Claude читает на каждое сообщение', `≈ ${fmt.tok(claude)} ток.`, `Описания включённых плагинов (${plugins.filter((p) => p.agents.includes('claude')).length}) и личных скиллов (${lib.tax.claude.skills}). Лишнее можно приглушить в проекте → «Инструменты».`),
    stat('Codex читает на каждое сообщение', `≈ ${fmt.tok(Math.min(codex, 2000))} ток.`, `Скиллов установлено: ${lib.tax.codex.skills}. Codex сам урезает список, поэтому лишние скиллы вытесняют нужные.`),
    stat('В запасе у hub', String(lib.tax.hubOnly), 'Скиллы, которые вы добавили через hub или из своих папок. Ничего не стоят, пока вы не подключите их к проекту.'));

  let tab = 'skills', q = '';
  const tabs = h('div'), body = h('div.stack'), searchBox = h('div');
  const find = findPanel({});
  const skillsTable = () => {
    const rows = skills.filter((e) => !q || (e.id + e.title + e.description).toLowerCase().includes(q)).sort((a, b) => b.tokenCost - a.tokenCost);
    return rows.length ? h('div.plane.card.tight', { style: { overflowX: 'auto' } }, h('table.tbl', h('thead', h('tr', h('th', 'Скилл'), h('th', 'Где работает'), h('th.r', { title: 'Сколько токенов стоит описание на каждое сообщение' }, 'Цена'), h('th.hide-s', 'Лицензия'))),
      h('tbody', rows.map((e) => { const [w, tone] = where(e); return h('tr', { style: { cursor: 'pointer' }, tabIndex: 0, onclick: () => detail(e), onkeydown: (ev) => { if (ev.key === 'Enter') detail(e); } },
        h('td', h('div.t-label', e.title), h('div.t-meta.clamp1', { style: { maxWidth: '52ch' } }, e.description)), h('td', chip(w, tone)), h('td.r.num', `${e.tokenCost} ток.`), h('td.hide-s', e.license === 'unknown' ? chip('не указана', 'warn') : e.license)); })))) : empty('Ничего не найдено');
  };
  const pluginList = () => {
    const rows = plugins.filter((p) => !q || (p.name + p.id).toLowerCase().includes(q));
    return h('div.stack', h('p.t-meta', 'Плагин — это пакет из скиллов, команд и MCP. Пока он включён, агент читает описания всех его скиллов в каждом проекте. Выключить для отдельного проекта можно в проекте → «Инструменты» → «Плагины».'),
      rows.length ? h('div.list', rows.map((p) => h('div.tool-row.plate', h('div.grow', h('div.title', h('span.clamp1', p.name), p.suggest ? chip('редко нужен', 'warn') : null, ...p.agents.map((a) => chip(a === 'claude' ? 'Claude' : 'Codex', 'line'))), h('div.sub.clamp1', `скиллов внутри: ${p.skills} · ${p.id}`)), chip(`${p.tokens} ток.`, p.tokens ? 'line' : 'ok')))) : empty('Включённых плагинов нет'));
  };
  const mcpList = () => h('div.stack', h('p.t-meta', 'MCP-сервер даёт агенту новые действия: браузер, Figma, базу данных. Здесь те, что известны hub; подключаются они к конкретному проекту.'),
    mcps.length ? h('div.list', mcps.map((e) => h('div.tool-row.plate', h('div.grow', h('div.title', e.title, e.sourceVerified ? null : chip('источник не проверен', 'warn')), h('div.sub', e.description)), chip(e.risk.network ? 'ходит в интернет' : 'работает локально', 'line')))) : empty('MCP пока нет', 'Найдите на вкладке «Найти новые».'));
  const current = () => (tab === 'skills' ? skillsTable() : tab === 'plugins' ? pluginList() : mcpList());
  const draw = () => {
    tabs.replaceChildren(pills([['skills', 'Скиллы', skills.length], ['plugins', 'Плагины', plugins.length], ['mcp', 'MCP', mcps.length], ['find', 'Найти новые']], tab, (k) => { tab = k; draw(); }, 'Разделы'));
    if (tab === 'find') { searchBox.replaceChildren(); body.replaceChildren(find.node); find.open(); return; }
    const input = h('input.input', { type: 'search', placeholder: 'Фильтр по названию', 'aria-label': 'Фильтр', value: q });
    input.addEventListener('input', debounce(() => { q = input.value.trim().toLowerCase(); body.replaceChildren(current()); }, 120));
    searchBox.replaceChildren(h('div.search', { style: { maxWidth: '420px' } }, icon('search', 'sm'), input));
    body.replaceChildren(current());
  };
  draw();
  return { title: 'Инструменты', node: h('div', pageHead({ title: 'Инструменты', sub: 'Скиллы, плагины и MCP на этом компьютере. Здесь видно, сколько они стоят, и можно найти новые.' }),
    top, h('section.group', h('div.row-flex', { style: { justifyContent: 'space-between', marginBottom: '12px' } }, tabs, searchBox), body)) };
}

async function detail(e) {
  let body = h('p.muted', e.description);
  if (e.source === 'local' && e.kind === 'skill') { try { const s = await api.get('/skill/' + encodeURIComponent(e.id), true); body = h('pre', s.text); } catch { /* not readable */ } }
  const [w, tone] = where(e);
  dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', e.title), h('div.row-flex', { style: { marginTop: '6px' } }, chip(KIND[e.kind] || e.kind, 'line'), chip(w, tone), chip(`${e.tokenCost} ток. на сообщение`, 'line'), chip(e.license === 'unknown' ? 'лицензия не указана' : e.license, e.license === 'unknown' ? 'warn' : 'line'), e.sourceVerified ? null : chip('источник не проверен', 'warn'))), closeBtn()), body,
    h('div.foot', btn('Закрыть', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }))), { wide: true });
}
