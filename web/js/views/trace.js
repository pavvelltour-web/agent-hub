// Detailed run trace (Phase 7.1): one row per model call with tokens, prompt size, cache share and tool calls, a timeline, the slowest tool calls
// and a JSONL download. The server sends names, numbers and times only (no tool input or output text); trace-model.js types them, and
// everything is drawn with h()/textContent (ADR-012).
import { api } from '../api.js';
import { agentBadge, btn, chip, empty, fmt, h, icon } from '../ui.js';
import { lanes, mergePage, msText, traceModel } from '../trace-model.js';
import { pageHead } from './common.js';

const PAGE = 100;
const OUTCOME_RU = { done: 'готово', review: 'ждёт ревью', failed: 'ошибка', limit: 'остановлен лимитом', stopped: 'остановлен вами', context: 'продолжен в новой сессии', interrupted: 'прерван' };
const pct = (x) => (x >= 1 ? 100 : Math.floor(x * 100)) + ' %';   // floor: 99.6 % is not shown as 100 %

const stat = (label, value, sub) => h('div.tr-stat', h('span.t-meta', label), h('b.tr-val', value), sub ? h('span.t-meta', sub) : null);
const cell = (label, value, tone) => h('div.tr-cell', h('span.t-meta', label), h('span.mono.tr-num' + (tone ? '.' + tone : ''), value));

function toolChip(t) {
  const bits = [t.name, msText(t.ms)];
  if (t.open) bits.push('без ответа'); else if (!t.ok) bits.push('ошибка');
  return chip(bits.join(' · '), t.open ? 'warn' : t.ok ? 'line' : 'err', t.bytes ? `ответ ${t.bytes} Б` : undefined);
}

function turnRow(t, runModel) {
  return h('div.tr-row', { 'data-turn': String(t.n) },
    h('div.row-flex.tr-head', h('b.t-label', `Шаг ${t.n}`), t.startedAt ? h('span.t-meta', fmt.time(t.startedAt)) : null, t.model && t.model !== runModel ? chip(t.model, 'line') : null),
    h('div.tr-cells',
      cell('Время', msText(t.ms)), cell('Вход', fmt.tok(t.tokens.newIn + t.tokens.cachedIn)), cell('Из кэша', t.tokens.newIn + t.tokens.cachedIn ? pct(t.cacheHit) : '—'),
      cell('Выход', fmt.tok(t.tokens.out)), cell('Контекст', t.context ? fmt.tok(t.context) : '—'), cell('Цена', t.costUsd == null ? 'неизвестна' : fmt.usd(t.costUsd))),
    t.tools.length || t.toolsMore ? h('div.tr-tools', t.tools.map(toolChip), t.toolsMore ? h('span.t-meta', `и ещё ${t.toolsMore}`) : null) : null);
}

function timeline(m) {
  const ls = lanes(m.turns), total = m.turns.reduce((a, t) => a + t.ms, 0);
  return h('div.stack.tr-gap',
    h('div.tr-line', { role: 'img', 'aria-label': `Шаги по времени: ${m.turns.length}, вместе ${msText(total)}` }, ls.map((l) => h('div.tr-seg', { style: { flexGrow: String(l.flex) }, title: `Шаг ${l.n}: ${msText(l.ms)}` },
      l.parts.map((p) => h('i.tr-part.' + (p.kind === 'rest' ? 'rest' : p.ok ? 'tool' : 'tool-bad'), { style: { flexGrow: String(p.flex) }, title: p.kind === 'rest' ? 'время модели' : p.name }))))),
    h('div.row-flex.tr-legend', h('span.t-meta', h('i.tr-sw.tool'), ' инструмент'), h('span.t-meta', h('i.tr-sw.tool-bad'), ' инструмент с ошибкой'), h('span.t-meta', h('i.tr-sw.rest'), ' остальное время шага')));
}

export default async function view(ctx) {
  const id = ctx.params[0];
  let m = null, failed = false;
  const body = h('div.stack.tr');
  const load = async () => {
    failed = false;
    m = traceModel(await api.get(`/runs/${id}/trace?limit=${PAGE}`, true).catch(() => null));
    if (!m) failed = true;
    draw();
  };
  const more = async (button) => {
    button.disabled = true;
    const next = traceModel(await api.get(`/runs/${id}/trace?after=${m.next}&limit=${PAGE}`, true).catch(() => null));
    if (next) m = mergePage(m, next);
    draw();
  };
  function draw() {
    if (failed || !m) { body.replaceChildren(empty('Разбор не открылся', 'Запуск не найден или сервер не ответил.', btn('Повторить', { kind: 'glass', icon: 'refresh', onclick: load }))); return; }
    const t = m.totals, input = t.newIn + t.cachedIn;
    const notes = [
      'Время считается по тому, когда hub получил строку от агента: это оценка, а не секундомер. Тексты команд и их вывод сюда не попадают.',
      m.run.agent === 'claude' ? 'Работа подагентов в этот разбор не входит.' : null,
      m.run.agent === 'codex' ? 'Codex не сообщает размер запроса по шагам, поэтому «Контекст» пуст.' : null,
      m.truncated ? 'Запуск очень длинный: показана только часть записей.' : null,
    ].filter(Boolean);
    body.replaceChildren(
      h('section.tr-card.stack.tr-gap', { 'aria-label': 'Итого' },
        h('div.row-flex.tr-head', m.run.agent ? agentBadge(m.run.agent) : null, m.run.model ? chip(m.run.model, 'line') : null, m.run.effort ? chip(m.run.effort, 'line') : null, m.run.outcome ? chip(OUTCOME_RU[m.run.outcome], m.run.outcome === 'failed' ? 'err' : 'soft') : chip('идёт', 'info'),
          h('div.grow'), btn('Обновить', { kind: 'glass', icon: 'refresh', onclick: load }), h('a.btn.btn-glass', { href: `/api/runs/${id}/trace.jsonl`, download: `trace-${id}.jsonl` }, icon('file', 'sm'), 'Скачать JSONL')),
        h('div.tr-stats', stat('Шагов', String(m.total || m.turns.length)), stat('Вход', fmt.tok(input), input ? `из кэша ${pct(t.cachedIn / input)}` : undefined), stat('Выход', fmt.tok(t.out)), stat('Время', msText(t.ms)),
          stat('Цена', t.costUsd == null ? 'неизвестна' : fmt.usd(t.costUsd), 'по таблице цен, примерно'))),
      m.turns.length ? h('section.tr-card.stack.tr-gap', { 'aria-label': 'Шаги по времени' }, h('h2.t-heading', 'Шаги по времени'), timeline(m)) : null,
      m.slowest.length ? h('section.tr-card.stack.tr-gap', { 'aria-label': 'Самые долгие шаги' }, h('h2.t-heading', 'Самые долгие шаги'),
        h('ol.tr-slow', m.slowest.slice(0, 5).map((s) => h('li', h('span.tr-slow-n', s.name), h('span.mono', msText(s.ms)), h('span.t-meta', `шаг ${s.turn}`))))) : null,
      m.turns.length ? h('section.stack.tr-gap', { 'aria-label': 'Все шаги' }, h('h2.t-heading', 'Все шаги'), m.turns.map((x) => turnRow(x, m.run.model)),
        m.next ? h('div.row-flex', (() => { const b = btn(`Показать ещё (${m.turns.length} из ${m.total})`, { kind: 'glass' }); b.onclick = () => more(b); return b; })()) : null)
        : empty('По шагам данных нет', 'Запуск ещё ничего не сделал, или он записан до появления подробного разбора.'),
      h('div.stack.tr-gap', notes.map((n) => h('p.t-meta', n))));
  }
  await load();
  return { title: 'Подробно о запуске', node: h('div', pageHead({ crumbs: [{ href: '/logs', text: 'Журнал' }], title: 'Подробно о запуске', sub: 'Что агент делал шаг за шагом: сколько токенов ушло и какие инструменты были вызваны.', actions: h('a.btn.btn-glass', { href: '#/chat/' + id }, 'Открыть чат') }), body) };
}
