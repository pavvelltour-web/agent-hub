// «Прогноз проекта» on the project overview (Phase 7.3): what the open tasks will take, as ranges, each number with its label (measured / estimate).
// The server computes; this file only draws what `forecast-model.js` typed. h()/textContent only (ADR-012): task files and messages are data.
import { api } from '../api.js';
import { chip, h } from '../ui.js';
import { basisText, forecastLine, forecastModel, pctRange, usdText, weeksText } from '../forecast-model.js';

const AGENT_RU = { claude: 'Claude', codex: 'Codex' };
const LABEL = { measured: ['измерено', 'ok'], estimated: ['оценка', 'soft'], unknown: ['неизвестно', 'line'] };
const labelChip = (l) => { const [t, tone] = LABEL[l] || LABEL.estimated; return chip(t, tone); };

/** A 0..100 % track with the band from the middle estimate to the cautious one. Over 100 % is said in words, never hidden by the track. */
function rangeBar(r, what) {
  const lo = Math.min(100, r.p50), hi = Math.min(100, r.p90);
  return h('div.fc-bar', { role: 'img', 'aria-label': `${what}: ${pctRange(r)}` },
    h('i.fc-band', { style: { left: lo + '%', width: Math.max(1.5, hi - lo) + '%' } }));
}

function draw(m) {
  if (!m) return h('p.muted', 'Прогноз не загрузился: обновите страницу.');
  if (!m.enough) {
    return h('div.stack.fc-gap', h('p.fc-line', m.reason || 'недостаточно данных'),
      h('p.t-meta', `Прогноз появится, когда будет хотя бы 5 завершённых задач из панели: так числа берутся из ваших запусков, а не придумываются. Открытых задач в файле: ${m.open}.`));
  }
  const pctRows = ['claude', 'codex'].filter((a) => m.limit[a]).map((a) => h('div.fc-row', h('b.t-label', AGENT_RU[a]), h('div.fc-grow', rangeBar(m.limit[a], 'Доля недельного лимита ' + AGENT_RU[a]), h('span', `${pctRange(m.limit[a])} недели`)), labelChip(m.limit[a].label)));
  const done = m.total > 0 ? Math.min(100, (m.done / m.total) * 100) : 0;
  return h('div.stack.fc-gap',
    h('p.fc-line', forecastLine(m)),
    m.total > 0 ? h('div.fc-burn', h('div.fc-track', { role: 'img', 'aria-label': `Сделано ${m.done} из ${m.total}` }, h('i.fc-done', { style: { width: done + '%' } })), h('span.t-meta', `Сделано ${m.done} из ${m.total}`)) : null,
    m.open === 0 ? null : h('div.fc-rows', pctRows,
      m.weeks ? h('div.fc-row', h('b.t-label', 'Срок'), h('span.fc-grow', weeksText(m.weeks)), labelChip(m.weeks.label)) : null,
      m.usd ? h('div.fc-row', h('b.t-label', 'Деньги'), h('span.fc-grow', usdText(m.usd) + ' (не счёт: у подписки лимит, а не оплата)'), labelChip(m.usd.label)) : null),
    m.risk.length && m.open > 0 ? h('div.stack.fc-gap', h('b.t-label', 'Что расширяет диапазон'), h('ul.fc-risk', m.risk.map((t) => h('li', t)))) : null,
    h('p.t-meta', basisText(m) + (m.guessed ? `. Тип у ${m.guessed} задач определён по тексту: можно указать его в файле в скобках, например [debug]` : '') + (m.truncated ? '. В файле больше 500 открытых задач: считаются первые 500' : '') + (m.files.length ? '. Файлы: ' + m.files.join(', ') : '')));
}

/** The block for the project overview: draws a note at once and fills in when the server answers. */
export function forecastBlock(projectId) {
  const box = h('div.fc-card.plate', { 'aria-live': 'polite' }, h('p.muted', 'Считаю прогноз…'));
  api.get(`/projects/${projectId}/forecast`, true).then((r) => box.replaceChildren(draw(forecastModel(r))), () => box.replaceChildren(draw(null)));
  return box;
}
