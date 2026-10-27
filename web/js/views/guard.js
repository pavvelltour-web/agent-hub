// The guardrails line on the Today page (Phase 7.5): shows ONLY when something needs the user: the circuit breaker stopped runs, the protection was switched off by the user,
// or the review gate was tightened. Quiet otherwise. h()/textContent only (ADR-012).
import { api } from '../api.js';
import { btn, chip, closeBtn, dialog, field, h, icon, toast } from '../ui.js';
import { CAP_KEYS, CAP_LABEL, guardModel } from '../guard-model.js';

export const loadGuard = () => api.get('/guardrails', true).then(guardModel, () => null);

/** `null` when there is nothing to say. */
export function guardLine(m) {
  if (!m) return null;
  const rows = [];
  if (!m.enabled) rows.push(h('div.alert.warn', { role: 'status' }, icon('alert'), h('div.stack', { style: { flex: 1 } }, h('b', 'Защита от лишних запусков выключена вами'), h('span', 'Ничто не остановит запуск, который тратит слишком много или повторяет одну и ту же ошибку. Включить обратно можно в настройках.'))));
  for (const t of m.trips) {
    rows.push(h('div.alert.err', { role: 'alert' }, icon('alert'), h('div.stack', { style: { flex: 1 } }, h('b', 'Защита остановила запуски'), h('span', (t.slug ? t.slug + ': ' : '') + t.ru),
      t.ackable ? h('div.row-flex', btn('Понятно, продолжить', { kind: 'glass', onclick: async () => { try { await api.post('/guardrails/ack', { key: t.key }); location.reload(); } catch { /* toast */ } } })) : null)));
  }
  if (m.review.tightened || m.review.flag) rows.push(h('div.alert.info', { role: 'status' }, icon('info'), h('div.stack', { style: { flex: 1 } }, h('b', m.review.tightened ? 'Ревью стало строже' : 'Ревьюер шумит'), h('span', m.review.why))));
  return rows.length ? h('section.stack', { 'aria-label': 'Защита запусков' }, rows) : null;
}

/** The settings card: state, the thresholds, «Изменить пороги…» (the server refuses out-of-range numbers) and the switch, which needs the typed word to turn OFF. */
export function guardSettings() {
  const box = h('div.stack', { 'aria-live': 'polite' }, h('p.muted', 'Загружаю…'));
  const draw = async () => {
    const m = await loadGuard();
    if (!m) { box.replaceChildren(h('p.muted', 'Не удалось загрузить.')); return; }
    const rows = CAP_KEYS.map((k) => h('div.set-row', h('span', CAP_LABEL[k]), h('b', m.caps[k] == null ? '—' : String(m.caps[k])), m.defaults[k] != null && m.caps[k] !== m.defaults[k] ? h('span.t-meta', `по умолчанию ${m.defaults[k]}`) : null));
    box.replaceChildren(
      h('div.row-flex', chip(m.enabled ? 'включена' : 'выключена вами', m.enabled ? 'ok' : 'warn'), h('span.t-meta', `Сегодня израсходовано ${Math.round(m.usage.weighted * 10) / 10} условных млн токенов${m.usage.usd > 0 ? `, ≈ $${Math.round(m.usage.usd)} по ценам API (по запускам, у которых цена известна)` : ''}`)),
      h('p.t-meta', 'Останавливает запуск, который тратит слишком много, и не даёт начать новые, если одна и та же ошибка повторяется или цепочка продолжений растёт. Файл hub.json в проекте может только сделать пороги строже.'),
      h('div.stack', rows), m.notes.length ? h('ul.t-meta', m.notes.map((n) => h('li', n))) : null,
      h('div.row-flex', btn('Изменить пороги…', { kind: 'glass', onclick: () => capsDialog(m, draw) }),
        m.enabled ? btn('Выключить защиту…', { kind: 'glass', onclick: () => offDialog(draw) }) : btn('Включить защиту', { kind: 'primary', onclick: async () => { try { await api.post('/guardrails', { enabled: true }); toast('Защита включена', 'ok'); draw(); } catch { /* toast */ } } })));
  };
  draw();
  return box;
}

function capsDialog(m, done) {
  const inputs = Object.fromEntries(CAP_KEYS.map((k) => [k, h('input.input', { type: 'number', inputmode: 'decimal', step: 'any', value: String(m.caps[k] ?? ''), 'aria-label': CAP_LABEL[k], min: m.ranges[k]?.min, max: m.ranges[k]?.max })]));
  const save = btn('Сохранить', { kind: 'primary', onclick: async () => {
    const caps = {};
    for (const k of CAP_KEYS) { const v = Number(inputs[k].value); if (inputs[k].value.trim() === '' || !Number.isFinite(v)) return toast('Введите числа во все поля', 'err'); caps[k] = v; }
    try { await api.post('/guardrails', { caps }); document.getElementById('dlg').close(); toast('Пороги сохранены', 'ok'); done(); } catch { /* toast: the server names the field */ }
  } });
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Пороги защиты'), closeBtn()), h('p.t-meta', 'У каждого поля свой допустимый диапазон; сервер не принимает число вне него.'),
    ...CAP_KEYS.map((k) => field(`${CAP_LABEL[k]}${m.ranges[k] ? ` (${m.ranges[k].min}–${m.ranges[k].max})` : ''}`, inputs[k])), h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), save)));
}

function offDialog(done) {
  const WORD = 'ВЫКЛЮЧИТЬ';
  const input = h('input.input', { 'aria-label': 'Слово подтверждения', autocomplete: 'off', spellcheck: false, 'data-autofocus': true });
  const go = btn('Выключить защиту', { kind: 'primary', disabled: true, onclick: async () => { try { await api.post('/guardrails', { enabled: false, confirm: input.value }); document.getElementById('dlg').close(); toast('Защита выключена. Верните её, когда закончите', 'ok'); done(); } catch { /* toast */ } } });
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== WORD; });
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Выключить защиту?'), closeBtn()),
    h('p', 'Без защиты ничто не остановит запуск, который съедает лимит или деньги, или повторяет одну и ту же ошибку. На главной странице будет висеть напоминание, пока она выключена.'),
    h('div.field', h('label', `Чтобы выключить, напечатайте: ${WORD}`), input), h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), go)));
}
