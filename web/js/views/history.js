import { api, qs } from '../api.js';
import { debounce, empty, fmt, h, icon, pills, avatar } from '../ui.js';
import { pageHead, sessionRow } from './common.js';

export default async function view() {
  const p = historyPanel({});
  return { title: 'История', node: h('div', pageHead({ title: 'История', sub: 'Все разговоры с Claude и Codex. Откройте любой, чтобы прочитать или продолжить. Из любого места поиск открывается клавишами Ctrl+K.' }), p.node), cleanup: p.cleanup };
}

const mark = (snippet) => snippet.split(/(\[[^\]]*\])/g).map((s) => (s.startsWith('[') && s.endsWith(']') ? h('mark', { style: { background: 'var(--hub-accent-soft)', color: 'var(--hub-accent-soft-ink)', borderRadius: '4px', padding: '0 2px' } }, s.slice(1, -1)) : s));

export function historyPanel({ projectId }) {
  let agent = '', q = '', limit = 40;
  const results = h('div.list'), filters = h('div'), more = h('div');
  const input = h('input.input', { type: 'search', placeholder: 'Найти по словам из разговоров', 'aria-label': 'Поиск по истории' });
  const run = async () => {
    results.replaceChildren(h('div.skeleton', { style: { height: '56px' } }));
    if (q) {
      const hits = await api.get('/search' + qs({ q, project: projectId, agent }));
      results.replaceChildren(...(hits.length ? hits.map((x) => h('a.row.plate', { href: '#/s/' + encodeURIComponent(x.sessionId) }, avatar(x.agent), h('div', h('div.title', h('span.clamp1', x.title || 'Без названия')), h('div.sub', { style: { whiteSpace: 'normal' } }, mark(x.snippet.replace(/\s+/g, ' ')))), h('div.right', h('span.t-meta', x.project || '')))) : [empty('Ничего не найдено', 'Попробуйте другое слово или выберите «Все».')]));
      more.replaceChildren();
    } else {
      const rows = await api.get('/sessions' + qs({ project: projectId, agent, limit }));
      results.replaceChildren(...(rows.length ? rows.map(sessionRow) : [empty('Разговоров пока нет', 'Нажмите «Обновить историю» в настройках.')]));
      more.replaceChildren(rows.length >= limit ? h('button.btn.btn-glass', { type: 'button', onclick: () => { limit += 40; run(); } }, 'Показать ещё') : '');
    }
  };
  const drawFilters = () => filters.replaceChildren(pills([['', 'Все'], ['claude', 'Claude'], ['codex', 'Codex']], agent, (k) => { agent = k; drawFilters(); run(); }, 'Агент'));
  input.addEventListener('input', debounce(() => { q = input.value.trim(); run(); }, 250));
  drawFilters(); run();
  return { node: h('div.stack', h('div.row-flex', h('div.search.grow', { style: { maxWidth: '520px' } }, icon('search', 'sm'), input), filters), results, more), cleanup() {} };
}
