// «Остаток лимита до сброса» (Phase 7.4): a switch per project (OFF by default, typed confirmation), the offers the hub can make, the approved queue, and the Today card.
// Nothing here starts anything: the hub only ever runs what the user approved with a click, one at a time, as an ordinary task. h()/textContent only (ADR-012).
import { api } from '../api.js';
import { agentBadge, btn, chip, closeBtn, dialog, h, sectionHead, toast } from '../ui.js';
import { agentText, autoModel, confirmMatches, kindText, statusText, suggestionLine } from '../autouse-model.js';

const load = (projectId) => api.get('/autouse' + (projectId ? `?project=${projectId}` : ''), true).then(autoModel, () => null);

function enableDialog(p, st, done) {
  const input = h('input.input', { 'aria-label': 'Название папки', autocomplete: 'off', spellcheck: false, 'data-autofocus': true });
  const go = btn('Включить', { kind: 'primary', disabled: true, onclick: async () => {
    go.disabled = true;
    try { await api.post('/autouse/enable', { projectId: p.id, enabled: true, confirm: input.value }); document.getElementById('dlg').close(); toast('Включено для этого проекта', 'ok'); done(); }
    catch { go.disabled = !confirmMatches(input.value, p.confirmWord); }
  } });
  input.addEventListener('input', () => { go.disabled = !confirmMatches(input.value, p.confirmWord); });
  const li = (t) => h('li', t);
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Использовать остаток лимита?'), closeBtn()),
    h('ul.au-list', li(`Когда до сброса лимита меньше ${st.maxHours} ч и свободно не меньше ${st.minLeftPct} %, hub предложит прогнать ревью старого кода или дописать тесты.`),
      li(`Само ничего не запускается: каждую работу вы одобряете кнопкой, одобрение действует ${st.approvalHours} ч.`),
      li('Запуск идёт как обычная задача: отдельная ветка, проверка и ваше принятие. Основная ветка не меняется.'),
      li(`Только по подписке, не по ключу API. Если лимит неизвестен или устарел, не запускается. Останавливается, когда остаётся меньше ${st.marginPct} %.`),
      li(`Работает ${st.loop || 'только пока открыта панель hub'}; выключить можно в любой момент.`)),
    h('div.field', h('label', `Чтобы включить, напечатайте название папки: ${p.confirmWord}`), input),
    h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), go)));
}

function offerRow(p, s, done) {
  return h('div.au-offer', h('div.au-text', agentBadge(s.agent), h('span', suggestionLine(s)), h('span.t-meta', `Съест около ${Math.round(s.pct)} % лимита${s.writes === 'branch' ? ', правки только в отдельной ветке' : ', ничего не меняет'}`)),
    btn('Одобрить', { kind: 'primary', onclick: async () => { try { await api.post('/autouse/approve', { projectId: p.id, kind: s.kind, agent: s.agent }); toast('Одобрено: запустится, когда условия сойдутся', 'ok'); done(); } catch { /* toast */ } } }));
}

function queueRow(i, done) {
  const [t, tone] = statusText(i.status);
  return h('div.au-item', h('div.au-text', agentBadge(i.agent, agentText(i.agent)), h('span', kindText(i.kind)), chip(t, tone), i.note ? h('span.t-meta', i.note) : null, i.runId ? h('a.t-meta', { href: `#/chat/${i.runId}` }, 'открыть запуск') : null),
    i.status === 'approved' ? btn('Отменить', { kind: 'glass', onclick: async () => { try { await api.post('/autouse/cancel', { id: i.id }); done(); } catch { /* toast */ } } }) : null);
}

/** The block for the project overview. */
export function autoBlock(projectId) {
  const box = h('div.au-card.plate', { 'aria-live': 'polite' }, h('p.muted', 'Загружаю…'));
  const draw = async () => {
    const m = await load(projectId), p = m?.projects.find((x) => x.id === projectId);
    if (!p) { box.replaceChildren(h('p.muted', 'Не удалось загрузить настройку.')); return; }
    const off = h('div.stack.au-gap', h('p', 'Выключено. Когда лимит агента скоро сбросится, а часть ещё не потрачена, hub может предложить занять её полезной работой. Ничего не запускается без вашего «да».'),
      h('div.row-flex', btn('Включить…', { kind: 'glass', icon: 'check', onclick: () => enableDialog(p, m.settings, draw) })));
    const on = h('div.stack.au-gap', m.scheduler.state === 'other' ? h('div.alert.warn', { role: 'status' }, h('div.stack', h('b', 'Другой процесс hub держит планировщик'), h('span', m.scheduler.silent ? 'Он давно не отзывался, но жив: автозапуск здесь не работает, пока он не закроется. Если он завис, закройте его.' : 'Автозапуск идёт там. Здесь он ничего не запускает и не останавливает.'))) : null, h('div.row-flex', chip('включено', 'ok'), h('span.t-meta', `Предложения при сбросе лимита меньше чем через ${m.settings.maxHours} ч и свободных ${m.settings.minLeftPct} % и больше. Запас ${m.settings.marginPct} %.`)),
      p.suggestions.length ? h('div.au-offers', p.suggestions.map((s) => offerRow(p, s, draw))) : h('p.muted', 'Сейчас предложить нечего.'),
      p.blocked.length ? h('ul.au-list', p.blocked.map((b) => h('li', `${agentText(b.agent)}: ${b.why}`))) : null,
      p.items.length ? h('div.stack.au-gap', h('b.t-label', 'Одобрено вами'), p.items.map((i) => queueRow(i, draw))) : null,
      h('div.row-flex', btn('Выключить', { kind: 'glass', onclick: async () => { try { await api.post('/autouse/enable', { projectId: p.id, enabled: false }); toast('Выключено, одобрения отменены', 'ok'); draw(); } catch { /* toast */ } } })));
    box.replaceChildren(p.enabled ? on : off);
  };
  draw();
  return box;
}

/** The Today card: only projects the user switched on, and only when there is something to offer. `null` when there is nothing to show. */
export function autoToday(m) {
  const rows = (m?.projects ?? []).filter((p) => p.enabled && p.suggestions.length);
  if (!rows.length) return null;
  const refresh = async (node) => { const next = autoToday(await load()); node.replaceWith(next ?? h('span')); };
  const node = h('section.group', sectionHead('Остаток лимита до сброса'),
    h('div.au-offers', rows.flatMap((p) => p.suggestions.map((s) => h('div.stack.au-gap', h('span.t-meta', p.slug), offerRow(p, s, () => refresh(node)))))));
  return node;
}
