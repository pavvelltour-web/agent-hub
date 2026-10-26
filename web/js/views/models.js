import { api } from '../api.js';
import { agentBadge, agentName, btn, chip, empty, field, fmt, h, pills, sectionHead, svgEl, toast } from '../ui.js';
import { EFFORT_RU, limitCard, modelName, pageHead, pctText, sessionRow, shortModel, TASKS } from './common.js';

const SHORT = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', gpt: 'GPT' };
const BALANCE = [[0.3, 'Только качество'], [0.6, 'Скорее качество'], [1, 'Баланс'], [2, 'Скорее цена'], [4, 'Только цена']];

/** Quality (up) against price (right). The ideal is the top-left corner: best quality for nothing. The chosen model is the closest dot. */
function qualityMap(options) {
  const W = 420, H = 260, L = 44, B = 36, T = 14, R = 16;
  const qs = options.map((o) => o.quality), lo = Math.max(0, Math.min(...qs, 0.5) - 0.1), hi = 1;
  const x = (price) => L + price * (W - L - R), y = (q) => T + (1 - (q - lo) / (hi - lo)) * (H - T - B);
  const chosen = options.find((o) => o.chosen);
  return svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'qmap', role: 'img', 'aria-label': 'Карта моделей: чем ближе точка к левому верхнему углу, тем лучше' },
    svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'qmap-frame' }),
    chosen ? svgEl('line', { x1: x(0), y1: y(1), x2: x(chosen.price), y2: y(chosen.quality), class: 'qmap-ray' }) : null,
    svgEl('circle', { cx: x(0), cy: y(1), r: 6, class: 'qmap-ideal' }), svgEl('text', { x: x(0) + 10, y: y(1) + 4, class: 'qmap-t' }, 'идеал'),
    options.map((o, i) => { const near = options.slice(0, i).some((p) => Math.hypot(x(p.price) - x(o.price), y(p.quality) - y(o.quality)) < 18); return [svgEl('circle', { cx: x(o.price), cy: y(o.quality), r: o.chosen ? 8 : 6, class: 'qmap-dot' + (o.chosen ? ' chosen' : '') }), svgEl('text', { x: x(o.price) + 11, y: y(o.quality) + 4 + (near ? 15 : 0), class: 'qmap-t' + (o.chosen ? ' chosen' : '') }, SHORT[o.key] || o.key)]; }),
    svgEl('text', { x: L, y: H - 10, class: 'qmap-a' }, '← дешевле'), svgEl('text', { x: W - R, y: H - 10, class: 'qmap-a', 'text-anchor': 'end' }, 'дороже →'),
    svgEl('text', { x: 6, y: T + 10, class: 'qmap-a' }, 'лучше'), svgEl('text', { x: 6, y: H - B - 2, class: 'qmap-a' }, 'хуже'));
}

export default async function view(ctx) {
  const name = ctx.params[0];
  return name ? modelPage(name) : overview();
}

async function overview() {
  const [m, oc, rt, rq] = await Promise.all([api.get('/models'), api.get('/outcomes'), api.get('/routing'), api.get('/review-eval', true).catch(() => null)]);
  const guide = m.guide;

  // ---- limits
  const limits = h('div.grid-2', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' } }, m.agents.map((a) => h('div.stack', limitCard(a), a.id === 'claude' ? manual() : h('p.t-meta', { style: { padding: '0 6px' } }, a.limit ? 'Codex сам пишет остаток в свои логи, hub берёт его оттуда.' : 'Остаток появится после первого разговора с Codex.'))));

  // ---- what matters more: quality or price; learn by trying
  const bal = h('div'), expl = h('div');
  const nearest = BALANCE.reduce((a, b) => (Math.abs(b[0] - rt.priceWeight) < Math.abs(a[0] - rt.priceWeight) ? b : a))[0];
  let weight = nearest, explore = rt.explore > 0;
  const saveRouting = async () => { try { await api.post('/routing', { priceWeight: weight, explore: explore ? 0.1 : 0 }); ask(); } catch { /* toast */ } };
  const drawBal = () => { bal.replaceChildren(pills(BALANCE.map(([v, t]) => [v, t]), weight, (v) => { weight = v; drawBal(); saveRouting(); }, 'Что важнее'));
    expl.replaceChildren(h('label.row-flex', { style: { minHeight: '44px' } }, h('input.check', { type: 'checkbox', checked: explore, onchange: (e) => { explore = e.target.checked; saveRouting(); } }), h('span', 'Иногда пробовать другую модель на простых задачах (1 из 10), чтобы hub узнавал, где можно сэкономить'))); };
  drawBal();

  // ---- pick a model for a task
  const result = h('div.stack');
  const cls = h('select.select', { 'aria-label': 'Задача', onchange: ask }, TASKS.map(([v, t]) => h('option', { value: v, selected: v === 'implement' }, t)));
  const scale = h('select.select', { 'aria-label': 'Размер', onchange: ask }, [[0.5, 'маленькая'], [1, 'обычная'], [2, 'большая'], [4, 'очень большая']].map(([v, t]) => h('option', { value: v, selected: v === 1 }, t)));
  const by = h('select.select', { 'aria-label': 'Кто писал код', onchange: ask }, [['', 'не важно'], ['claude', 'Claude'], ['codex', 'Codex']].map(([v, t]) => h('option', { value: v }, t)));
  const byField = field('Кто писал код', by);
  const sec = h('input.check', { type: 'checkbox', 'aria-label': 'Касается безопасности', onchange: ask });
  async function ask() {
    byField.hidden = cls.value !== 'review';
    const r = await api.post('/advise', { cls: cls.value, scale: Number(scale.value), securityBoundary: sec.checked, ...(cls.value === 'review' && by.value ? { implementedBy: by.value } : {}) }, true).catch(() => null);
    if (!r) return;
    const c = r.choice, e = r.estimate, alt = c.alt;
    const tokens = e.tokens.low.cachedIn + e.tokens.low.uncachedIn, tokensHi = e.tokens.high.cachedIn + e.tokens.high.uncachedIn;
    result.replaceChildren(
      h('div.pick-card.plane.card.stack',
        h('span.t-meta', 'Лучше всего'),
        h('div.row-flex', agentBadge(c.agent, modelName(guide, c.agent, shortModel(c.agent, c.model))), chip('мышление: ' + (EFFORT_RU[c.effort] || c.effort), 'line')),
        h('p', c.reason),
        h('div.row-flex', chip(`≈ ${fmt.tok(tokens)}–${fmt.tok(tokensHi)} токенов`, 'line'), e.usd ? chip(`≈ $${e.usd.low}–$${e.usd.high}`, 'line') : null, e.percent ? chip(pctText(e.percent), 'line') : null, chip(e.confidence === 'low' ? 'прогноз грубый' : 'прогноз средней точности', e.confidence === 'low' ? 'warn' : 'ok')),
        e.notes.length ? h('details', h('summary.t-meta', 'Почему прогноз неточный'), h('ul.t-meta', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, e.notes.map((n) => h('li', n)))) : null),
      c.options ? h('div.plate.card.tight.stack', h('b.t-label', 'Карта: качество и цена'), qualityMap(c.options), h('p.t-meta', rt.observedRuns >= 3 ? `Чем ближе точка к «идеалу», тем лучше выбор. Качество считается по вашим оценкам задач (учтено запусков: ${rt.observedRuns}), а где данных мало, берётся оценка автора.` : 'Чем ближе точка к «идеалу», тем лучше выбор. Пока качество — оценка автора: оценивайте задачи в чате («Получилось?»), и карта станет вашей.')) : null,
      alt ? h('div.plate.card.tight.row-flex', h('span.t-meta', 'Запасной вариант:'), agentBadge(alt.agent, modelName(guide, alt.agent, shortModel(alt.agent, alt.model))), h('span.t-meta.grow', alt.why)) : null);
  }
  ask();

  // ---- every model in plain words
  const group = (agent, title) => h('section.plane.card.stack', h('div.row-flex', agentBadge(agent, title)),
    h('div.list', guide.filter((g) => g.agent === agent).map((g) => h('div.model-row', h('b', g.name), h('span', g.use), h('span.t-meta', g.note)))));

  const usage = m.usage.length ? h('table.tbl', h('thead', h('tr', h('th', 'Модель'), h('th', 'Агент'), h('th.r', 'Разговоров'), h('th.r.hide-s', 'Прочитано'), h('th.r', 'Написано'), h('th.r', 'Стоило бы по API'))),
    h('tbody', m.usage.map((u) => h('tr', h('td', h('a', { href: '#/models/' + encodeURIComponent(u.model) }, fmt.model(u.model))), h('td', agentName(u.agent)), h('td.r.num', u.sessions), h('td.r.num.hide-s', fmt.tok(u.uncachedIn + u.cachedIn)), h('td.r.num', fmt.tok(u.out)), h('td.r.num', u.costUsd == null ? h('span.t-meta', 'цена не известна') : fmt.usd(u.costUsd)))))) : empty('За 30 дней разговоров нет', 'Загрузите историю в настройках.');
  const mw = (v) => (v == null ? '—' : v < 0.01 ? '<0.01' : v.toFixed(2));
  const outcomes = oc.rows.length ? h('table.tbl', h('thead', h('tr', h('th', 'Задача'), h('th', 'Модель'), h('th.r', 'Запусков'), h('th.r', 'Успешно'), h('th.r', 'Факт'), h('th.r.hide-s', 'Прогноз'))),
    h('tbody', oc.rows.map((o) => h('tr', h('td', (TASKS.find(([v]) => v === o.cls) || [0, 'без типа'])[1]), h('td', fmt.model(o.model)), h('td.r.num', o.runs), h('td.r.num', Math.round(100 * o.done / o.runs) + '%'), h('td.r.num', mw(o.actualMw)), h('td.r.num.hide-s', o.estLowMw == null ? '—' : `${mw(o.estLowMw)}–${mw(o.estHighMw)}`))))) : empty('Пока нечего сравнивать', 'Когда вы запустите задачи из панели, здесь появится сравнение прогноза с фактом.');

  return { title: 'Модели', node: h('div', pageHead({ title: 'Модели и лимиты', sub: 'Сколько осталось у каждого агента и какую модель брать для задачи. Hub выбирает и среди Claude, и среди GPT.' }), limits,
    h('section.group', sectionHead('Подобрать модель'), h('div.plane.card.stack', h('div.stack', { style: { gap: '8px' } }, h('b.t-label', 'Что для вас важнее'), bal, expl), h('div.row-flex', field('Задача', cls), field('Размер', scale), byField, h('label.row-flex', { style: { alignSelf: 'flex-end', minHeight: '44px' } }, sec, h('span.t-label', 'Касается безопасности'))), result)),
    h('section.group', sectionHead('Какая модель для чего'), h('div.grid-2', group('claude', 'Claude'), group('codex', 'GPT через Codex')),
      h('details.plane.card', { style: { marginTop: '12px' } }, h('summary.t-label', 'Как hub выбирает модель'), h('ol', { style: { margin: '10px 0 0', paddingLeft: '20px', display: 'grid', gap: '6px' } },
        h('li', 'По типу задачи: планы и проверка кода у Opus, обычная работа у Sonnet, пересказы у Haiku.'),
        h('li', 'Если правка касается безопасности, проверяет самая сильная модель.'),
        h('li', 'Если шаг не получается дважды, добавляется мышление; трижды — переход на Opus.'),
        h('li', 'Код, написанный Claude, проверяет GPT, и наоборот: чужие ошибки видно лучше.'),
        h('li', 'Если у Claude лимит почти кончился, а у Codex запас есть, работа уходит в Codex. Если кончились оба, hub предложит подождать сброса.')))),
    reviewQuality(rq),
    h('section.group', sectionHead('Расход за 30 дней', h('span.t-meta', `цены Claude проверены ${m.pricesVerifiedAt}; цены GPT не известны`)), h('div.plane.card.tight', { style: { overflowX: 'auto' } }, usage)),
    h('details.group', h('summary', h('span.t-heading', 'Точность прогнозов')), h('p.t-meta', 'Прогноз и факт в миллионах токенов с учётом кэша. Чем больше запусков, тем точнее советы.'), h('div.plane.card.tight', { style: { overflowX: 'auto' } }, outcomes))) };
}

/** «Качество ревью»: the last saved measurement of the reviewers on the known cases (numbers only, never the diffs). Hostile or missing data shows «не измерялось». */
function reviewQuality(ev) {
  const n = (v, max = 1e6) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);
  const b = ev && typeof ev.baseline === 'object' && ev.baseline ? ev.baseline : null, c = ev && typeof ev.cases === 'object' && ev.cases ? ev.cases : {};
  const tile = (label, value, hint) => h('div.plate.card.tight.stack', h('span.t-meta', label), h('b.t-heading', value), h('span.t-meta', hint));
  const date = b && typeof b.savedAt === 'string' ? b.savedAt.slice(0, 10) : '';
  return h('section.group', sectionHead('Качество ревью'), h('div.plane.card.stack',
    b ? h('div.grid-2', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
      tile('Находит известные ошибки', Math.round(n(b.recall, 1) * 100) + '%', 'доля ошибок в примерах, которые ревью заметило'),
      tile('Лишних замечаний', n(b.noiseOnClean, 100).toFixed(2), 'в среднем на пример без ошибок'),
      tile('Кругов ревью', n(b.roundsToPass, 10).toFixed(1), 'пока ревью перестаёт находить новое'))
      : h('p', 'не измерялось'),
    h('p.t-meta', `Примеров: ${n(c.total)} (встроенных ${n(c.seed)}, из ваших случаев ${n(c.incident)}). С ошибкой: ${n(c.buggy)}, без ошибок: ${n(c.clean)}.`),
    h('p.t-meta', b ? `Замер от ${date || '—'}. Если поменять подсказки или модели ревью, замер повторяют командой hub review-eval --compare: число найденных ошибок не должно упасть.` : 'Чтобы замерить, выполните в терминале: hub review-eval --save-baseline (тратит лимит подписки, нужен вход в Claude или Codex). Любое замечание ревью можно сохранить как пример на экране ревью.')));
}

function manual() {
  const input = h('input.input', { type: 'number', min: 0, max: 100, placeholder: 'например, 40', 'aria-label': 'Сколько процентов лимита Claude использовано', style: { width: '140px' } });
  return h('div.plate.card.tight.stack', h('b.t-label', 'Вписать остаток Claude'), h('p.t-meta', 'Claude не пишет остаток в файлы. Наберите в Claude Code команду /usage и впишите сюда, сколько процентов уже использовано.'),
    h('div.row-flex', input, btn('Сохранить', { kind: 'glass', onclick: async () => { try { await api.post('/limits', { agent: 'claude', usedPercent: Number(input.value) }); toast('Сохранено', 'ok'); location.reload(); } catch { /* toast */ } } })));
}

async function modelPage(name) {
  const [sessions, m] = await Promise.all([api.get('/sessions?model=' + encodeURIComponent(name) + '&limit=40'), api.get('/models')]);
  const u = m.usage.find((x) => x.model === name);
  return { title: fmt.model(name), node: h('div', pageHead({ crumbs: [{ text: 'Модели', href: '/models' }], title: fmt.model(name), sub: u ? `${agentName(u.agent)} · разговоров за 30 дней: ${u.sessions} · ${fmt.usd(u.costUsd)}` : 'За 30 дней не использовалась' }),
    h('div.list', sessions.length ? sessions.map(sessionRow) : [empty('Разговоров с этой моделью нет')])) };
}
