import { api, prefs, qs } from './api.js';
import { avatar, clear, closeBtn, debounce, dialog, h, icon, skeleton } from './ui.js';

prefs.set({});   // re-apply saved theme/accent/material

const ROUTES = [
  [/^\/$/, () => import('./views/today.js')],
  [/^\/projects$/, () => import('./views/projects.js')],
  [/^\/p\/(\d+)\/review\/(rv[0-9a-z]{2,40})$/, () => import('./views/review.js')],
  [/^\/p\/(\d+)(?:\/(chat|tasks|history|library|tools|logs))?(?:\/(\w+))?$/, () => import('./views/project.js')],
  [/^\/chat(?:\/(\w+))?$/, () => import('./views/chat.js')],
  [/^\/history$/, () => import('./views/history.js')],
  [/^\/s\/(.+)$/, () => import('./views/session.js')],
  [/^\/models(?:\/(.+))?$/, () => import('./views/models.js')],
  [/^\/library$/, () => import('./views/library.js')],
  [/^\/logs$/, () => import('./views/logs.js')],
  [/^\/settings$/, () => import('./views/settings.js')],
];
const NAV = [
  ['/', 'Сегодня', 'today'], ['/projects', 'Проекты', 'folder'], ['/chat', 'Чат', 'chat'], ['/history', 'История', 'history'],
  ['/models', 'Модели', 'models'], ['/library', 'Инструменты', 'library'], ['/logs', 'Журнал', 'logs'],
];
const section = (path) => (path === '/' ? '/' : '/' + path.split('/')[1]);
const navKey = (path) => (path.startsWith('/p/') ? '/projects' : path.startsWith('/s/') ? '/history' : section(path));

const app = document.getElementById('app');
const main = h('main.main', { id: 'main', tabIndex: -1 });
let cleanup = null, seq = 0;

function navLink([href, label, ic], cls, cur) {
  return h('a.' + cls, { href: '#' + href, 'aria-current': cur === href ? 'page' : null }, icon(ic), h('span', label));
}
/** Ctrl+K: search every message of every agent without leaving the page. Enter opens the first hit. */
function quickSearch() {
  const out = h('div.list', { style: { maxHeight: '55vh', overflowY: 'auto' } });
  const input = h('input.input', { type: 'search', placeholder: 'Слово или фраза из разговора', 'aria-label': 'Поиск по всем разговорам', autofocus: true });
  const close = () => document.getElementById('dlg').close();
  let first = null;
  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) { first = null; out.replaceChildren(h('p.t-meta', { style: { padding: '8px' } }, 'Ищет по тексту всех разговоров с Claude и Codex. Enter открывает первый результат.')); return; }
    const hits = await api.get('/search' + qs({ q }), true).catch(() => []);
    first = hits[0] ? '#/s/' + encodeURIComponent(hits[0].sessionId) : null;
    out.replaceChildren(...(hits.length ? hits.map((x) => h('a.row.plate', { href: '#/s/' + encodeURIComponent(x.sessionId), onclick: close }, avatar(x.agent), h('div', h('div.title', h('span.clamp1', x.title || 'Без названия')), h('div.sub', x.project || 'без проекта')))) : [h('p.t-meta', { style: { padding: '8px' } }, 'Ничего не найдено')]));
  }, 200);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && first) { location.hash = first; close(); } });
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Поиск по всем разговорам'), closeBtn()), h('div.search', icon('search', 'sm'), input), out));
  run(); setTimeout(() => input.focus(), 30);
}
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSearch(); } });

function shell(cur) {
  const rail = h('nav.rail.glass', { 'aria-label': 'Разделы' },
    h('a.logo', { href: '#/', 'aria-label': 'agent hub — Сегодня' }, icon('chat')),
    NAV.map((n) => navLink(n, 'nav-item', cur)), h('div.spacer'), navLink(['/settings', 'Настройки', 'settings'], 'nav-item', cur));
  const more = () => dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Разделы'), closeBtn()), [['/history', 'История', 'history'], ['/library', 'Инструменты', 'library'], ['/logs', 'Журнал', 'logs'], ['/settings', 'Настройки', 'settings']].map(([href, label, ic]) => h('a.btn.btn-glass', { href: '#' + href, onclick: () => document.getElementById('dlg').close() }, icon(ic, 'sm'), label))));
  const dock = h('nav.dock.glass', { 'aria-label': 'Разделы (телефон)' },
    [NAV[0], NAV[1], NAV[2], NAV[4]].map((n) => navLink(n, 'nav-item', cur)),
    h('button.nav-item', { type: 'button', style: { background: 'none', border: 0 }, onclick: more }, icon('logs'), h('span', 'Ещё')));
  return [rail, dock];
}

async function route() {
  const mine = ++seq;
  cleanup?.(); cleanup = null;
  const raw = location.hash.slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  const q = new URLSearchParams(query);
  let loader, params = [];
  for (const [re, ld] of ROUTES) { const m = re.exec(path); if (m) { loader = ld; params = m.slice(1).map((x) => (x == null ? x : decodeURIComponent(x))); break; } }
  const cur = navKey(path);
  clear(app).append(...shell(cur), main);
  clear(main).append(h('div.wrap', skeleton(4)));
  if (!loader) { clear(main).append(h('div.wrap', h('div.empty', h('div.t-heading', 'Такой страницы нет'), h('a.btn.btn-glass', { href: '#/' }, 'На главную')))); return; }
  try {
    const mod = await loader();
    const view = await mod.default({ params, q, path, go: (p) => { location.hash = '#' + p; } });
    if (mine !== seq) { view.cleanup?.(); return; }
    cleanup = view.cleanup || null;
    document.title = (view.title ? view.title + ' · ' : '') + 'Agent Hub';
    clear(main).append(h('div.wrap', view.node));
    window.scrollTo(0, 0);
  } catch (e) {
    if (mine !== seq) return;
    clear(main).append(h('div.wrap', h('div.alert.err', icon('alert'), h('div.stack', h('b', 'Не удалось открыть страницу'), h('span', e.message || String(e))))));
  }
}
window.addEventListener('hashchange', route);
route();
api.get('/state', true).catch(() => {});
