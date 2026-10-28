// Orchestrator map (ADR-027): the orchestrator at the top, a node for every run it started, native sub-agents, background processes and hub jobs below it, with the reason on every
// edge. Click a node for its model, goal, context, what it was taught, its log, and a message box where messaging is possible. A step journal sits underneath.
// Everything from the server is drawn with h()/textContent (ADR-012); the layout is the pure map-model.js.
import { api, qs } from '../api.js';
import { btn, chip, clear, closeBtn, dialog, empty, fmt, h, icon, svgEl, toast } from '../ui.js';
import { changedToDone, contextPct, kindLabel, layout, reasonLabel, statusLabel, statusTone } from '../map-model.js';
import { pageHead, projectSelect, projectsList } from './common.js';

const GLYPH = { orchestrator: 'map', run: 'task', subagent: 'branch', background: 'term', hubjob: 'refresh', mcp: 'library' };
const POLL_MS = 3000;
const NATIVE = new Set(['subagent', 'background']);
const ownerOf = (id) => (/^(?:sub|bg):(r[0-9a-z]{2,40}):/.exec(id) || [])[1];
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function ctxBar(n) {
  if (n.context === undefined || n.kind === 'background' || n.kind === 'hubjob' || n.kind === 'mcp') return null;
  const p = contextPct(n.context);
  if (p == null) return h('div.mn-ctx', h('span.t-meta', 'контекст: не измерен'));
  return h('div.mn-ctx' + (p >= 80 ? '.warm' : ''), h('div.meter', { role: 'img', 'aria-label': `Контекст ${p} %` }, h('b', { style: { width: p + '%' } })), h('span.t-meta', `контекст ${fmt.tok(n.context.used)} из ${fmt.tok(n.context.limit)}`));
}

function eventLine(e) {
  const d = e.data || {};
  if (e.kind === 'text') return '· ' + clip(String(d.text || ''), 300);
  if (e.kind === 'tool') return '▸ ' + clip(`${d.name || 'tool'}: ${d.summary || ''}`, 300);
  if (e.kind === 'error') return '! ' + clip(String(d.message || ''), 300);
  if (e.kind === 'warn') return '⚠ ' + clip(String(d.message || ''), 300);
  if (e.kind === 'done') return d.ok === false ? '✗ завершён с ошибкой' : '✓ завершён';
  return null;
}

export default async function view(ctx) {
  const projects = await projectsList();
  if (!projects.length) return { title: 'Карта', node: h('div', pageHead({ title: 'Карта', sub: 'Оркестратор и всё, что он запустил.' }), empty('Пока нет проектов', 'Добавьте папку на экране «Сегодня»: потом здесь появится схема работы.')) };

  let pid = projects.some((p) => p.id === Number(ctx.q.get('p'))) ? Number(ctx.q.get('p')) : projects[0].id;
  const root = /^r[0-9a-z]{2,40}$/.test(ctx.q.get('root') || '') ? ctx.q.get('root') : '';
  let map = { nodes: [], edges: [], truncated: 0 }, selected = null, jtask = 'chat', timer = null, gone = false, fit = false;
  const prev = {}, settle = new Set();

  const scroller = h('div.map-scroll', { tabindex: 0, 'aria-label': 'Схема проекта, прокручивается' });
  const drawerHost = h('aside.map-drawer', { 'aria-live': 'polite' });
  const journalHost = h('section.stack');
  const legend = h('div.map-legend.t-meta',
    h('span', icon('map', 'sm'), ' оркестратор и запуски'), h('span', h('i'), 'запущен hub'), h('span', h('i.dash'), 'внутри агента (субагент, фоновый процесс)'), h('span', h('i.live'), 'идёт сейчас'));

  const nodeBtn = (n) => {
    const big = !NATIVE.has(n.kind) && n.kind !== 'hubjob' && n.kind !== 'mcp';
    return h('button.map-node.k-' + n.kind + '.s-' + n.status + (settle.has(n.id) ? '.settle' : '') + (selected === n.id ? '.sel' : ''), {
      type: 'button', 'data-id': n.id, style: { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }, 'aria-pressed': String(selected === n.id),
      'aria-label': `${kindLabel(n.kind)} ${n.label}, ${statusLabel(n.status)}. ${n.goal || ''}`, onclick: () => select(n.id),
    },
    h('div.row-flex.mn-head', icon(GLYPH[n.kind] || 'info', 'sm'), h('b.t-label', n.label), chip(statusLabel(n.status), statusTone(n.status))),
    big ? h('span.t-meta.mono', n.model ? n.model + (n.effort ? ' · ' + n.effort : '') : kindLabel(n.kind)) : null,
    h('span.mn-goal', n.goal || reasonLabel(n.why)), big ? ctxBar(n) : null);
  };

  function drawCanvas() {
    const L = layout(map);
    clear(scroller);
    if (!L.nodes.length) { scroller.append(h('div', { style: { padding: '24px' } }, empty('Пока нет запусков', 'Запустите задачу на экране «Сегодня»: здесь появится схема.'))); return; }
    const running = new Set(L.nodes.filter((n) => n.status === 'running').map((n) => n.id));
    const kindOf = new Map(L.nodes.map((n) => [n.id, n.kind]));
    const s = fit ? Math.min(1, Math.max(0.35, (scroller.clientWidth - 8) / L.width)) : 1;
    scroller.append(h('div.map-canvas', { style: { width: L.width * s + 'px', height: L.height * s + 'px' } }, h('div.map-zoom', { style: { width: L.width + 'px', height: L.height + 'px', transform: `scale(${s})` } },
      svgEl('svg', { class: 'map-edges', width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, 'aria-hidden': 'true' },
        L.edges.map((e) => svgEl('path', { d: e.d, class: 'map-edge' + (NATIVE.has(kindOf.get(e.to)) ? ' dash' : '') + (running.has(e.to) ? ' live' : '') }))),
      L.edges.map((e) => h('span.map-edge-label.t-meta', { title: reasonLabel(e.reason), style: { left: e.lx + 'px', top: e.ly + 'px' } }, reasonLabel(e.reason))),
      L.nodes.map(nodeBtn))));
  }

  function logBlock(n) {
    if (!n.runId) return null;
    const pre = h('pre.map-log', 'Нажмите «Показать лог».');
    return h('div.stack', h('div.row-flex', btn('Показать лог', { icon: 'logs', onclick: async () => {
      pre.textContent = 'Загружаю…';
      try { const r = await api.get(`/runs/${n.runId}`, true); const lines = (r.events || []).map(eventLine).filter(Boolean).slice(-40); pre.textContent = lines.length ? lines.join('\n') : 'В логе пока нет строк.'; }
      catch { pre.textContent = 'Не удалось прочитать лог.'; }
    } }), h('a.btn.btn-glass', { href: '#/trace/' + n.runId }, icon('clock', 'sm'), 'Трасса по шагам')), pre);
  }

  function messageBlock(n) {
    const owner = ownerOf(n.id), native = !n.messageable && !!owner, rid = n.messageable ? n.runId : owner;
    const ownerNode = owner ? map.nodes.find((x) => x.runId === owner) : null;
    let why = null;
    if (!rid) why = n.kind === 'hubjob' ? 'Это задача самого hub: ей нельзя писать.' : n.runId ? (n.status === 'running' ? 'Запуск ещё идёт: написать ему можно после окончания (или остановите его).' : /^review /.test(n.why) ? 'Ревьюеры работают сами по заданию: им нельзя писать.' : 'У запуска нет сессии, продолжить его нельзя.') : 'Этому узлу нельзя написать.';
    else if (native && ownerNode && ownerNode.status === 'running') why = 'Оркестратор ещё работает: спросить его об этом узле можно после окончания.';
    if (why) return h('p.t-meta', why);
    const ta = h('textarea', { name: 'map-message', placeholder: native ? 'Вопрос оркестратору об этом узле…' : 'Сообщение этому запуску…', maxlength: 8000, 'aria-label': native ? 'Вопрос оркестратору' : 'Сообщение запуску' });
    const send = btn(native ? 'Спросить оркестратора' : 'Отправить', { kind: 'primary', icon: 'send', onclick: async () => {
      const text = ta.value.trim(); if (!text) return;
      send.disabled = true;
      try { await api.post('/map/message', { runId: rid, text, ...(native ? { about: n.id } : {}) }); toast('Сообщение отправлено: запуск продолжен', 'ok'); ta.value = ''; await load(true); drawJournal(); }
      catch { /* the api helper has shown the reason */ } finally { send.disabled = false; }
    } });
    return h('div.stack.map-msg', native ? h('p.t-meta', 'Напрямую до субагента или фонового процесса дотянуться нельзя: вопрос уйдёт оркестратору, который его запустил.') : null, ta, h('div.row-flex', send));
  }

  function drawDrawer() {
    clear(drawerHost);
    const n = map.nodes.find((x) => x.id === selected);
    if (!n) { drawerHost.append(h('div.stack', h('h2.t-heading', 'Выберите узел'), h('p.t-meta', 'Нажмите на карточку на схеме: здесь будут модель, цель, контекст, чему обучен агент, лог и сообщение.'))); return; }
    const row = (k, v) => (v == null || v === '' ? [] : [h('dt', k), h('dd', v)]);
    drawerHost.append(h('div.stack',
      h('div.row-flex', icon(GLYPH[n.kind] || 'info'), h('h2.t-heading', n.label), chip(statusLabel(n.status), statusTone(n.status))),
      h('span.t-meta', kindLabel(n.kind)),
      h('dl.map-facts', ...row('Агент', n.agent === 'codex' ? 'Codex' : n.agent === 'claude' ? 'Claude' : n.agent), ...row('Модель', n.model), ...row('Усилие', n.effort), ...row('Ветка', n.branch),
        ...row('Контекст', n.context === undefined ? null : n.context ? `${fmt.tok(n.context.used)} из ${fmt.tok(n.context.limit)}` : 'не измерен'), ...row('Цена', n.costUsd === undefined ? null : fmt.usd(n.costUsd))),
      h('div.stack', h('b.t-label', 'Что делает'), h('p', n.goal || '—'), h('b.t-label', 'Зачем он здесь'), h('p', reasonLabel(n.why))),
      n.taught ? h('div.stack', h('b.t-label', 'Чему обучен агент'),
        h('div.row-flex', { style: { flexWrap: 'wrap' } }, n.taught.rules.map((r) => chip('правила: ' + r, 'soft')), n.taught.skills.map((s) => chip(s === '*' ? 'навыки: все' : 'навык: ' + s, 'line')), (n.taught.skillsIfLinked || []).map((s) => chip('навык, если подключён: ' + s, 'line')), !n.taught.rules.length && !n.taught.skills.length ? h('span.t-meta', 'правил и навыков режим не задаёт') : null)) : null,
      n.detail ? h('div.stack', h('b.t-label', 'Подробности'), h('p', n.detail)) : null,
      n.status === 'running' && n.runId ? btn('Остановить запуск', { icon: 'stop', onclick: async () => { try { await api.post(`/runs/${n.runId}/stop`); toast('Останавливаю…'); await load(true); } catch { /* shown */ } } }) : null,
      logBlock(n), messageBlock(n)));
  }

  function select(id) { selected = id; drawCanvas(); drawDrawer(); if (window.matchMedia('(max-width: 960px)').matches) drawerHost.scrollIntoView({ block: 'nearest' }); }

  async function drawJournal() {
    clear(journalHost);
    const tasks = ['chat', ...new Set(map.nodes.map((n) => /^hub\/([^/]+)\//.exec(n.branch || '')?.[1]).filter(Boolean))];
    if (!tasks.includes(jtask)) jtask = 'chat';
    let j = null;
    try { j = await api.get('/journal' + qs({ projectId: pid, task: jtask }), true); } catch { /* shown below */ }
    const sel = h('select.select', { name: 'journal-task', 'aria-label': 'Задача журнала', onchange: (e) => { jtask = e.target.value; drawJournal(); } }, tasks.map((t) => h('option', { value: t, selected: t === jtask }, t === 'chat' ? 'чаты и запуски без ветки' : t)));
    journalHost.append(h('div.row-flex', h('h2.t-heading', 'Журнал шагов'), sel, btn('Обновить', { icon: 'refresh', onclick: drawJournal })));
    if (!j) { journalHost.append(h('p.t-meta', 'Журнал не прочитался.')); return; }
    journalHost.append(h('p.t-meta', j.entries.length ? `Записей: ${j.entries.length}${j.truncated ? ' (журнал достиг предела и дальше не пополняется)' : ''}. Файл в проекте: ${j.plan?.path} (${j.plan?.action === 'create' ? 'будет создан' : 'будет обновлён'}). Hub сам в проект ничего не пишет: только после вашего подтверждения.` : 'Пока нет записей: журнал заполняется, когда hub запускает агентов.'),
      h('pre.map-journal-md', j.markdown),
      h('div.row-flex', btn('Записать в specs/…', { kind: 'primary', icon: 'file', disabled: !j.entries.length, onclick: () => {
        const d = dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Записать журнал в проект?'), closeBtn()),
          h('p.t-meta', `Будет ${j.plan.action === 'create' ? 'создан' : 'обновлён'} файл ${j.plan.path}. Перед записью делается резервная копия; отменить можно командой hub undo.`), h('pre.map-journal-md', j.markdown),
          h('div.row-flex', btn('Отмена', { kind: 'glass', onclick: () => d.close() }), btn('Подтвердить и записать', { kind: 'primary', onclick: async () => {
            try { const r = await api.post('/journal/apply', { projectId: pid, task: jtask, digest: j.plan.digest, approved: true }); d.close(); toast(`Записано: ${r.written.join(', ')}`, 'ok'); drawJournal(); }
            catch { /* shown; a changed journal asks to look again */ }
          } }))));
      } })));
  }

  async function load(quiet) {
    if (gone) return;
    try { map = await api.get('/map' + qs({ projectId: pid, root }), true); }
    catch (e) { if (!quiet) toast(e.message || 'Карта не загрузилась', 'err'); return; }
    const finished = changedToDone(prev, map.nodes);
    for (const id of finished) settle.add(id);
    for (const n of map.nodes) prev[n.id] = n.status;
    note.textContent = map.truncated ? `Показаны первые ${map.nodes.length} узлов, ещё ${map.truncated} скрыто.` : '';
    drawCanvas(); drawDrawer();
    if (finished.length) drawJournal();   // a step just ended: the journal has a new line
    if (settle.size) setTimeout(() => { settle.clear(); }, 800);
    clearTimeout(timer);
    if (!gone && map.nodes.some((n) => n.status === 'running')) timer = setTimeout(() => load(true), POLL_MS);
  }

  const note = h('span.t-meta');
  const fitBtn = btn('Вписать в окно', { icon: 'map', onclick: () => { fit = !fit; fitBtn.lastChild.textContent = fit ? 'Крупно' : 'Вписать в окно'; fitBtn.setAttribute('aria-pressed', String(fit)); drawCanvas(); } });
  const picker = projectSelect(projects, pid, (id) => { pid = id; selected = null; Object.keys(prev).forEach((k) => delete prev[k]); load(); drawJournal(); });
  const node = h('div.stack',
    pageHead({ title: 'Карта', sub: 'Оркестратор и всё, что он запустил: модель, цель, контекст и причина каждого шага.', actions: h('div.row-flex', picker, fitBtn, btn('Обновить', { icon: 'refresh', onclick: () => { load(); drawJournal(); } })) }),
    legend, note, h('div.map-wrap', scroller, drawerHost), journalHost);
  await load(true); await drawJournal();
  return { title: 'Карта', node, cleanup: () => { gone = true; clearTimeout(timer); } };
}
