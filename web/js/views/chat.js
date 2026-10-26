import { api, qs, stream } from '../api.js';
import { agentBadge, agentName, avatar, btn, chip, closeBtn, copy, dialog, empty, fmt, h, icon, md, toast } from '../ui.js';
import { EFFORT, go, outcomeChip, pageHead, projectSelect, TASKS, threadsOf, workModePicker } from './common.js';

const PERMS = [['plan', 'Только читать'], ['edit', 'Можно править файлы'], ['full', 'Без подтверждений']];

export default async function view(ctx) {
  const projectId = ctx.q.get('project') ? Number(ctx.q.get('project')) : undefined;
  const panel = await chatPanel({ projectId, runId: ctx.params[0], q: ctx.q, global: true });
  return { title: 'Чат', node: h('div', pageHead({ title: 'Чат', sub: 'Пишите задачу, как в Claude Code или Codex. Если у одного кончится лимит, работу можно передать другому.' }), panel.node), cleanup: panel.cleanup };
}

/** Shared chat UI. `global` shows a project picker; inside a project the project is fixed. */
export async function chatPanel({ projectId, runId, q, global }) {
  const [projects, runs0, models, matrix] = await Promise.all([api.get('/projects'), api.get('/runs' + qs({ project: projectId, limit: 150 })), api.get('/models'), api.get('/modes/matrix').catch(() => ({}))]);
  let runs = runs0;
  let pid = projectId ?? (q?.get('project') ? Number(q.get('project')) : (projects.find((p) => p.exists)?.id));
  let threads = threadsOf(runs);
  let current = null;              // { runs: [...] } being shown, or null for a new chat
  let live = null;                 // { runId, close }
  let permChoice = null, fullOk = false;   // permChoice: only what the user clicked; everything else comes from the thread or the work mode
  /** What will really apply: a review is always read-only; else the click, else the thread's last run, else the work mode, else edit. */
  const effPerm = () => (state.workMode === 'review' && !current ? 'plan' : permChoice ?? (current ? current.last.permission : workModes.find((x) => x.id === state.workMode)?.permission) ?? 'edit');
  const closers = [];
  const state = { agent: q?.get('agent') || 'auto', model: q?.get('model') || '', effort: q?.get('effort') || '', cls: q?.get('cls') || 'implement', workMode: q?.get('workMode') || 'chat', depth: q?.get('depth') || 'normal' };
  let workModes = [];
  const modelOpts = (agent) => (agent === 'auto' ? [['', 'выберет hub']] : [['', 'по умолчанию'], ...models.guide.filter((g) => g.agent === agent).map((g) => [g.id, g.name])]);

  const list = h('div.list');
  const transcript = h('div.transcript', { 'aria-live': 'polite' });
  const head = h('div.chat-head');
  const ta = h('textarea.textarea', { rows: 1, placeholder: 'Что сделать? Enter отправляет, Shift+Enter переносит строку', 'aria-label': 'Сообщение', 'data-autofocus': true });
  const sendBtn = h('button.btn.btn-primary.btn-icon', { type: 'button', 'aria-label': 'Отправить' }, icon('send'));
  const opts = h('div.opts');
  const composer = h('div.composer', h('div.box', ta, sendBtn), opts);
  const node = h('div.chat-layout',
    h('aside.threads.glass', { 'aria-label': 'Чаты' }, h('div.row-flex', { style: { justifyContent: 'space-between', padding: '4px 6px 6px' } }, h('span.t-heading', 'Чаты'), btn('Новый', { kind: 'glass', icon: 'plus', class: 'btn-sm', onclick: () => newChat() })), list),
    h('section.chat-main.plane', head, transcript, composer));

  const claudeLogin = models.agents.find((a) => a.id === 'claude');
  const limitOf = (id) => models.agents.find((a) => a.id === id)?.limit;

  // ---------- threads list ----------
  function drawList() {
    list.replaceChildren(...(threads.length ? threads.map((t) => {
      const r = t.root, l = t.last;
      const proj = global ? projects.find((p) => p.id === r.projectId)?.slug : null;
      return h('button.thread', { type: 'button', 'aria-current': String(current?.id === t.id), onclick: () => open(t) },
        h('span.t1', avatar(l.agent), h('span.clamp1', (r.prompt || 'Чат').replace(/\s+/g, ' ').slice(0, 60))),
        h('span.t2', outcomeChip(l), proj ? h('span.clamp1', proj) : null, h('span', fmt.ago(l.startedAt))));
    }) : [h('p.t-meta', { style: { padding: '8px 10px' } }, 'Пока нет чатов. Напишите первое сообщение справа.')]));
  }

  // ---------- header + composer options ----------
  function drawHead() {
    const lastAgent = current?.last.agent;
    head.replaceChildren(
      global && !current ? h('div.field', { style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, icon('folder', 'sm'), projectSelect(projects, pid, (v) => { pid = v; })) : null,
      current ? h('div.row-flex', agentBadge(lastAgent), chip(fmt.model(current.last.model), 'line'), current.last.effort ? chip(current.last.effort, 'line') : null, current.last.branch ? chip(current.last.branch, 'info') : null) : h('span.t-meta', 'Новый чат'),
      h('div.grow'), current ? btn('Что происходило', { kind: 'glass', icon: 'logs', class: 'btn-sm', onclick: showLog }) : null, ...['claude', 'codex'].map((id) => { const l = limitOf(id); const p = l && !l.stale ? l.usedPercent : null; return h('span.t-meta.row-flex', { style: { gap: '6px' } }, avatar(id), p == null ? 'лимит не известен' : `осталось ${Math.max(0, 100 - Math.round(p))}%`); }));
  }
  /** Full event log of the current thread: every event with time, kind and short content. Downloadable. */
  async function showLog() {
    const all = [];
    for (const r of current.runs) { const d = await api.get('/runs/' + r.id, true).catch(() => null); if (d) d.events.forEach((e) => all.push({ run: r.id, agent: r.agent, ...e })); }
    const sum = (e) => { const d = e.data || {}; return d.text || d.summary || d.message || (e.kind === 'usage' ? `вход ${fmt.tok(d.uncachedIn + d.cachedIn)} · выход ${fmt.tok(d.out)}` : e.kind === 'end' ? d.outcome : d.nativeId || ''); };
    const blob = () => URL.createObjectURL(new Blob([JSON.stringify(all, null, 1)], { type: 'application/json' }));
    dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', 'Что происходило в этом чате'), h('p.t-meta', `Событий: ${all.length}. Пароли и ключи вырезаны.`)), closeBtn()),
      h('div', { style: { maxHeight: '55vh', overflow: 'auto' } }, all.map((e) => h('div.log-row', { style: { gridTemplateColumns: '90px 90px 90px minmax(0,1fr)' } }, h('span.t-meta.mono', fmt.time(e.ts)), h('span.lv.' + (e.kind === 'error' ? 'error' : e.kind === 'limit' || e.kind === 'warn' ? 'warn' : 'info'), e.kind), h('span.t-meta', e.agent), h('span.msg-t', String(sum(e)).slice(0, 300))))),
      h('div.foot', h('a.btn.btn-glass', { href: blob(), download: 'chat-log.json' }, icon('file', 'sm'), 'Скачать JSON'))), { wide: true });
  }
  const CAP = { read: 'читает', write: 'пишет', shell: 'команды', network: 'сеть' }, RES = { allowed: 'да', denied: 'нет', asked: 'спросит', unknown: '?' };
  /** What was measured for the chosen agent + mode on this CLI version; honest about "not measured". */
  function permStatus() {
    const m = matrix[state.agent];
    if (!m?.verified || !m.matrix?.[effPerm()]) return chip('права не проверены', 'line', 'Запустите «hub doctor --modes», чтобы измерить, что этот режим реально разрешает');
    return chip('проверено на этой версии', 'ok', Object.entries(m.matrix[effPerm()]).map(([k, v]) => `${CAP[k]}: ${RES[v]}`).join(' · '));
  }
  async function loadWorkModes() {
    workModes = await api.get(`/workmodes?project=${current ? current.last.projectId : pid}&agent=${state.agent === 'codex' ? 'codex' : 'claude'}`, true).catch(() => workModes);
    drawOpts();
  }
  function drawOpts() {
    const sel = (key, items, label) => h('div.field', h('label', label), h('select.select', { 'aria-label': label, onchange: (e) => { state[key] = e.target.value; if (key === 'agent') { state.model = ''; drawOpts(); loadWorkModes(); } } }, items.map(([v, t]) => h('option', { value: v, selected: state[key] === v }, t))));
    opts.replaceChildren(
      sel('agent', [['auto', 'Выберет hub'], ['claude', 'Claude'], ['codex', 'Codex (GPT)']], 'Кто работает'),
      sel('model', modelOpts(state.agent), 'Модель'), sel('cls', TASKS, 'Тип задачи'), sel('effort', EFFORT, 'Глубина мышления'),
      h('div.pills.glass', { role: 'group', 'aria-label': 'Права агента' }, PERMS.map(([k, t]) => h('button.pill', { type: 'button', 'aria-pressed': String(effPerm() === k), title: k === 'plan' ? 'Агент только читает и планирует' : k === 'edit' ? 'Агент правит файлы проекта; что ещё он может, показывает пометка «проверено / не проверено»' : 'Агент делает всё без вопросов: опасно', onclick: () => pickPerm(k) }, t))),
      state.agent === 'claude' || state.agent === 'codex' ? permStatus() : null,
      workModes.length && !current ? workModePicker(workModes, state.workMode, (k) => { state.workMode = k; const m = workModes.find((x) => x.id === k); if (m) state.cls = m.cls; permChoice = null; drawOpts(); }, state.depth, (d) => { state.depth = d; drawOpts(); }) : null,
      claudeLogin && !claudeLogin.installed ? chip('Claude Code не установлен', 'warn') : null);
  }
  function pickPerm(k) {
    if (state.workMode === 'review' && !current) return toast('В режиме «Ревью» агент только читает', 'err');
    if (k !== 'full' || fullOk) { permChoice = k; drawOpts(); return; }
    dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Без подтверждений'), closeBtn()), h('p', 'Агент будет выполнять любые команды сам и ничего не спросит. Включайте только в отдельной ветке и в проекте, который не жалко.'),
      h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), btn('Всё равно включить', { kind: 'danger', onclick: () => { fullOk = true; permChoice = 'full'; document.getElementById('dlg').close(); drawOpts(); } }))));
  }

  // ---------- transcript ----------
  const stick = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 140;
  const toBottom = () => { transcript.scrollTop = transcript.scrollHeight; };
  const note = (t) => transcript.append(h('div.note', t));

  function renderRun(run, events, liveRun) {
    const isHandoff = !!run.handoffOf;
    if (run.resumeOf?.startsWith('session:')) note('Продолжение разговора из истории: агент помнит, что было раньше');
    if (isHandoff) note(`Продолжение после лимита: ${agentName(run.agent)} получил короткую запись о сделанном, а не весь чат`);
    if (!isHandoff) transcript.append(h('div.msg.user', h('div.bubble', run.prompt || '')));
    const ctxr = { tool: null, usage: null };
    events.forEach((e) => renderEvent(run, e, ctxr));
    if (liveRun && !events.some((e) => e.kind === 'end')) { const t = h('div.msg.assistant.typing-row', avatar(run.agent), h('div.bubble', h('span.typing', h('i'), h('i'), h('i')))); transcript.append(t); }
  }
  function renderEvent(run, e, c) {
    transcript.querySelector('.typing-row')?.remove();
    const d = e.data || {};
    if (e.kind === 'text') transcript.append(h('div.msg.assistant', avatar(run.agent), h('div.bubble', md(d.text))));
    else if (e.kind === 'tool') { c.tool = h('details.tool', h('summary', h('span.nm', d.name), h('span.sm', d.summary || '')), h('div.res')); transcript.append(c.tool); }
    else if (e.kind === 'tool_result') { if (c.tool) { c.tool.querySelector('.res').textContent = d.summary || '(пусто)'; if (d.isError) c.tool.classList.add('bad'); } }
    else if (e.kind === 'usage') c.usage = d;
    else if (e.kind === 'warn' && !String(d.message).startsWith('handoff_ready')) note(d.message);
    else if (e.kind === 'error') transcript.append(errorCard(d));
    else if (e.kind === 'limit' && d.reached) transcript.append(h('div.alert.warn', icon('alert'), h('div.stack', h('b', `${agentName(run.agent)}: лимит исчерпан`), h('span', d.message.slice(0, 220)), d.resetsAt ? h('span.t-meta', 'Сброс ' + fmt.until(d.resetsAt)) : null)));
    else if (e.kind === 'end') {
      const u = c.usage;
      note(`${({ done: 'готово', failed: 'ошибка', limit: 'остановлено лимитом', stopped: 'остановлено вами', interrupted: 'прервано' })[d.outcome] || d.outcome}${u ? ` · ${fmt.tok(u.uncachedIn + u.cachedIn)} токенов на входе, ${fmt.tok(u.out)} на выходе${u.costUsd ? ` · $${u.costUsd.toFixed(3)}` : ''}` : ''}`);
      if (d.outcome === 'limit') showHandoff(run);
      if (d.outcome === 'done' || d.outcome === 'failed') rateRow(run);
    }
  }
  /** One tap that tells hub whether the model did the job. It is the only quality signal that is not a guess. */
  function rateRow(run) {
    const box = h('div.rate.t-meta');
    const ask = () => box.replaceChildren('Получилось?', ...[[2, 'Да'], [1, 'Частично'], [0, 'Нет']].map(([v, t]) => btn(t, { kind: 'glass', class: 'btn-sm', onclick: async () => { try { await api.post(`/runs/${run.id}/rating`, { rating: v }); box.replaceChildren('Спасибо: учту при выборе модели.'); } catch { /* toast */ } } })));
    if (run.rating != null) box.replaceChildren('Ваша оценка: ' + ['не получилось', 'частично', 'получилось'][run.rating]); else ask();
    transcript.append(box);
  }
  function errorCard(d) {
    if (d.needsLogin) return h('div.alert.err', icon('lock'), h('div.stack', h('b', 'Claude не подключён'), h('span', 'Нужно один раз войти в аккаунт. Нажмите кнопку, войдите в открывшемся окне и отправьте сообщение ещё раз.'), h('div', btn('Войти в Claude', { kind: 'primary', onclick: () => api.post('/agents/login', { agent: 'claude' }).then(() => toast('Окно входа открыто', 'ok')).catch(() => {}) }))));
    return h('div.alert.err', icon('alert'), h('div.stack', h('b', 'Агент вернул ошибку'), h('span', d.message)));
  }
  async function showHandoff(run) {
    const r = await api.get('/runs/' + run.id, true).catch(() => null);
    const card = r?.card;
    if (!card) return;
    const to = run.agent === 'codex' ? 'claude' : 'codex';
    const toModel = to === 'claude' ? models.routing.implement.model : 'gpt-6.1-sol';
    const toLimit = limitOf(to);
    const blocked = toLimit && !toLimit.stale && (toLimit.usedPercent ?? 0) >= 95;
    const box = h('div.alert.info', icon('handoff'), h('div.stack', { style: { flex: 1 } },
      h('b', `${agentName(run.agent)} остановился: кончился лимит`),
      h('span', 'Работа сохранена. Другой агент продолжит с того же места по короткой записи (ветка, файлы, что не получилось), объяснять заново не нужно.'),
      h('div.row-flex',
        btn(`Продолжить в ${agentName(to)}`, { kind: 'primary', disabled: blocked, title: blocked ? 'У этого агента тоже нет запаса' : '', onclick: async () => { try { const x = await api.post(`/runs/${run.id}/handoff`, { agent: to, model: to === 'claude' ? 'sonnet' : toModel, effort: 'medium' }); runs = [x.run, ...runs]; threads = threadsOf(runs); await open(threads.find((t) => t.runs.some((q2) => q2.id === x.run.id))); startLive(x.run); } catch { /* toast */ } } }),
        btn('Что запомнили', { kind: 'glass', onclick: () => dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Запись о сделанном'), closeBtn()), h('pre', card.markdown), h('div.foot', btn('Копировать', { kind: 'glass', icon: 'copy', onclick: () => copy(card.markdown) }))), { wide: true }) }),
        card.resetsAt ? h('span.t-meta', `Или подождать: лимит вернётся ${fmt.until(card.resetsAt)}`) : null)));
    transcript.append(box);
    if (stick()) toBottom();
  }

  async function open(t) {
    stopLive();
    current = t; drawHead(); drawList();
    transcript.replaceChildren(h('div.skeleton', { style: { height: '60px' } }));
    const detail = await Promise.all(t.runs.map((r) => api.get('/runs/' + r.id, true).catch(() => ({ run: r, events: [] }))));
    transcript.replaceChildren();
    detail.forEach((d, i) => { const liveRun = d.run.live && i === detail.length - 1; renderRun(d.run, d.events, liveRun); if (liveRun) attach(d.run, d.events.at(-1)?.seq || 0); });
    toBottom();
    history.replaceState(null, '', location.hash.replace(/\/chat(\/\w+)?/, '/chat/' + t.last.id));
  }
  function attach(run, after) {
    const c = { tool: transcript.querySelector('details.tool:last-of-type'), usage: null };
    const close = stream(run.id, after, (e) => { const s = stick(); renderEvent(run, e, c); if (s) toBottom(); }, async () => { live = null; setBusy(false); await refresh(); });
    live = { runId: run.id, close }; setBusy(true);
  }
  function stopLive() { live?.close(); live = null; setBusy(false); }
  function setBusy(b) {
    sendBtn.replaceChildren(icon(b ? 'stop' : 'send'));
    sendBtn.setAttribute('aria-label', b ? 'Остановить' : 'Отправить');
    sendBtn.classList.toggle('btn-primary', !b); sendBtn.classList.toggle('btn-danger', b);
    ta.disabled = false;
  }
  async function refresh() { runs = await api.get('/runs' + qs({ project: projectId, limit: 150 }), true).catch(() => runs); threads = threadsOf(runs); if (current) current = threads.find((t) => t.runs.some((r) => current.runs.some((c) => c.id === r.id))) || current; drawList(); drawHead(); }
  function newChat() { stopLive(); current = null; transcript.replaceChildren(emptyState()); drawHead(); drawList(); ta.focus(); history.replaceState(null, '', location.hash.replace(/\/chat\/\w+/, '/chat')); }
  function emptyState() {
    const examples = ['Объясни, как устроен проект, и найди слабые места', 'Почини упавший тест и покажи, что изменилось', 'Составь план задачи и оцени, сколько она съест лимита'];
    return h('div.chat-empty', h('div.avatar.av-hub', { style: { width: '52px', height: '52px', fontSize: '20px' } }, 'h'), h('h2.t-title', 'С чего начнём?'),
      h('p.muted', 'Опишите задачу своими словами. Если выбрано «Выберет hub», он сам подберёт агента и модель по задаче и остатку лимитов.'),
      h('div.stack', { style: { width: '100%' } }, examples.map((e) => h('button.btn.btn-glass', { type: 'button', style: { justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }, onclick: () => { ta.value = e; ta.focus(); } }, icon('spark', 'sm'), e))));
  }

  // ---------- sending ----------
  async function send() {
    if (live) { await api.post(`/runs/${live.runId}/stop`).catch(() => {}); return; }
    const prompt = ta.value.trim();
    if (!prompt) return;
    if (!pid) { toast('Выберите проект: слева сверху или на странице «Проекты»', 'err'); return; }
    const last = current?.last;
    let agent = state.agent;
    const canResume = last?.sessionNativeId && (agent === 'auto' || agent === last.agent) && last.outcome !== 'limit';
    if (canResume) agent = last.agent;
    else if (current && last && agent !== 'auto' && agent !== last.agent) { note(`Новый чат: ${agentName(agent)} не видит прошлую переписку ${agentName(last.agent)}. Чтобы передать работу, дождитесь остановки по лимиту: появится кнопка «Продолжить».`); current = null; }
    ta.value = ''; autosize();
    try {
      const r = await api.post('/runs', { projectId: current ? current.last.projectId : pid, prompt, agent, ...(state.model ? { model: state.model } : {}), ...(state.effort ? { effort: state.effort } : {}), cls: state.cls, ...(permChoice ? { permission: permChoice } : {}), ...(canResume ? { resumeRunId: last.id } : !current ? { workMode: state.workMode, ...(state.workMode === 'autopilot' ? { depth: state.depth } : {}) } : {}) });
      if (!current) { transcript.replaceChildren(); }
      runs = [r.run, ...runs]; threads = threadsOf(runs);
      current = threads.find((t) => t.runs.some((x) => x.id === r.run.id));
      drawList(); drawHead();
      renderRun(r.run, [], true); toBottom();
      if (r.advice) note(`hub выбрал ${agentName(r.advice.agent)} · ${fmt.model(r.advice.model)}. ${r.advice.reason}`);
      attach(r.run, 0);
    } catch { ta.value = prompt; autosize(); }
  }
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);

  drawOpts(); loadWorkModes(); drawList(); drawHead();
  const start = runId ? threads.find((t) => t.runs.some((r) => r.id === runId)) : null;
  if (start) await open(start);
  else { transcript.replaceChildren(emptyState()); if (q?.get('prompt')) { ta.value = q.get('prompt'); autosize(); if (q.get('send')) setTimeout(send, 50); } }
  return { node, cleanup: () => { stopLive(); closers.forEach((c) => c()); } };
}
