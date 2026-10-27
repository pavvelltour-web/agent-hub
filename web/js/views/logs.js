import { api, qs } from '../api.js';
import { btn, debounce, empty, fmt, h, icon, pills } from '../ui.js';
import { pageHead } from './common.js';

export default async function view() {
  const p = logsPanel({});
  return { title: 'Журнал', node: h('div', pageHead({ title: 'Журнал', sub: 'Что происходило: запуски агентов, ошибки, остановки по лимиту, передачи работы и изменения файлов. Пароли и ключи сюда не попадают.' }), p.node), cleanup: p.cleanup };
}

const LEVEL = { error: ['Ошибка', 'error'], warn: ['Внимание', 'warn'], info: ['Событие', 'info'], audit: ['Изменение', 'audit'] };
const OUTCOME = { done: 'закончил работу', review: 'закончил работу, ждёт ревью', failed: 'остановился с ошибкой', limit: 'остановился: кончился лимит', stopped: 'остановлен вами', interrupted: 'прерван' };
const who = (a) => (a === 'codex' ? 'Codex' : a === 'claude' ? 'Claude' : 'Hub');

/** Turn a raw log row into one plain sentence. */
function say(r) {
  const m = r.message || '';
  if (r.source === 'end') return `${who(r.agent)} ${OUTCOME[m.replace(/^run /, '')] || m}`;
  if (r.source === 'handoff') return `${who(r.agent)}: работа сохранена, другой агент может продолжить`;
  if (r.source === 'limit') return `${who(r.agent)}: лимит. ${m}`;
  if (r.source === 'warn' && /^context_continue:/.test(m)) return `${who(r.agent)}: контекст стал большим, работа продолжена в новой сессии`;
  if (r.source === 'audit') {
    if (m.startsWith('apply-plan')) return 'Hub записал файлы в проект (после вашего подтверждения, есть резервная копия)';
    if (m.startsWith('undo')) return 'Изменение файлов отменено';
    if (m.startsWith('graph-update')) return r.ok === true ? 'Граф проекта обновлён (graphify, без модели)' : 'Граф проекта не обновился';
    if (m.startsWith('approve-stage')) return 'Шаг проекта подтверждён';
    return m;
  }
  if (r.source === 'warn' && /^hook /.test(m)) return `Хук проекта: ${m.replace(/^hook /, '')}`;
  return `${r.agent ? who(r.agent) + ': ' : ''}${m}`;
}

export function logsPanel({ projectId }) {
  let level = '', q = '', rows = [], auto = true;
  const box = h('div.plane.card.tight');
  const filters = h('div');
  const load = async () => { rows = await api.get('/logs' + qs({ project: projectId, limit: 300 }), true).catch(() => rows); draw(); };
  const draw = () => {
    const list = rows.filter((r) => (!level || r.level === level) && (!q || (say(r) + r.source + (r.agent || '')).toLowerCase().includes(q)));
    const n = (l) => rows.filter((r) => r.level === l).length;
    filters.replaceChildren(pills([['', 'Всё', rows.length], ['error', 'Ошибки', n('error')], ['warn', 'Лимиты и внимание', n('warn')], ['info', 'Запуски', n('info')], ['audit', 'Изменения файлов', n('audit')]], level, (k) => { level = k; draw(); }, 'Что показать'));
    box.replaceChildren(...(list.length ? list.map((r) => { const [label, cls] = LEVEL[r.level] || LEVEL.info; return h('div.log-row', h('span.t-meta', fmt.date(r.ts)), h('span.lv.' + cls, label), r.runId ? h('a.msg-t', { href: '#/chat/' + r.runId, title: 'Открыть этот чат' }, say(r)) : h('span.msg-t', say(r))); })
      : [empty('Записей нет', 'Здесь появятся запуски агентов, ошибки и изменения файлов.')]));
  };
  const input = h('input.input', { type: 'search', placeholder: 'Найти в журнале', 'aria-label': 'Найти в журнале' });
  input.addEventListener('input', debounce(() => { q = input.value.trim().toLowerCase(); draw(); }, 150));
  const save = () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(rows, null, 1)], { type: 'application/json' })), download: 'hub-journal.json' }); a.click(); };
  load();
  const timer = setInterval(() => { if (auto && document.visibilityState === 'visible') load(); }, 5000);
  return { node: h('div.stack', h('div.row-flex', filters, h('div.grow'), h('div.search', { style: { maxWidth: '280px' } }, icon('search', 'sm'), input), btn('Сохранить файлом', { kind: 'glass', icon: 'file', onclick: save }), h('label.row-flex.t-meta', h('input.check', { type: 'checkbox', checked: true, onchange: (e) => { auto = e.target.checked; } }), 'Обновлять сам')), box), cleanup: () => clearInterval(timer) };
}
