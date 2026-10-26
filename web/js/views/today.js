import { api } from '../api.js';
import { agentBadge, agentName, btn, chip, closeBtn, copy, dialog, empty, field, fmt, h, icon, pills, sectionHead, toast } from '../ui.js';
import { addProjectDialog, agentCard, EFFORT, go, limitLine, linkProject, modelName, openFolder, pageHead, pctText, runRow, sessionRow, shortModel, TASKS, workModePicker } from './common.js';

export default async function view() {
  const [runs, models, sessions, projects, state] = await Promise.all([api.get('/runs?limit=60'), api.get('/models'), api.get('/sessions?limit=6'), api.get('/projects'), api.get('/state')]);
  const handedOff = new Set(runs.filter((r) => r.handoffOf).map((r) => r.handoffOf));
  const needs = runs.filter((r) => r.outcome === 'limit' && !handedOff.has(r.id));
  const failed = runs.filter((r) => r.outcome === 'failed' && !r.live && Date.now() - Date.parse(r.startedAt) < 86400000).slice(0, 3);
  const live = runs.filter((r) => r.live);
  const proj = (id) => projects.find((p) => p.id === id)?.slug || 'проект';

  const waiting = [...needs.slice(1), ...failed];
  const agentsBox = h('div.stack');
  const drawAgents = (st) => agentsBox.replaceChildren(...['claude', 'codex'].map((id) => h('div.stack', { style: { gap: '8px' } }, agentCard({ id, ...st.agents[id] }, { onChange: recheck }), limitLine(models.agents.find((a) => a.id === id) || { id }))));
  async function recheck() { try { drawAgents(await api.get('/state')); } catch { /* toast */ } }
  drawAgents(state);

  const left = h('div.stack',
    waiting.length ? h('section.group', sectionHead('Ждут вашего решения', chip(String(waiting.length), 'soft')), h('div.list', waiting.map((r) => runRow(r)))) : null,
    live.length ? h('section.group', sectionHead('Работают сейчас', chip(String(live.length), 'info')), h('div.list', live.map((r) => runRow(r)))) : null,
    h('section.group', sectionHead('Продолжить', h('a.btn.btn-text.btn-sm', { href: '#/history' }, 'Вся история')),
      sessions.length ? h('div.list', sessions.map(sessionRow)) : empty('Разговоров пока нет', 'Нажмите «Обновить историю» в настройках: старые разговоры с Claude и Codex появятся здесь, и их можно будет продолжить.')));
  const right = h('aside.stack', h('section.group', sectionHead('Агенты'), agentsBox), h('a.btn.btn-glass', { href: '#/models' }, icon('models', 'sm'), 'Какая модель для чего'));

  return { title: 'Сегодня', node: h('div', pageHead({ title: 'Сегодня', sub: needs.length ? 'Работа остановилась, нужно ваше решение.' : '' }),
    needs.length ? await decision(needs[0], models, proj) : null,
    projects.length ? start(projects, models, state) : welcome(state),
    h('div.grid-2', { style: { marginTop: '24px' } }, left, right)) };
}

/** The main question of the app: where, who and what. Three steps on one card. */
function start(projects, models, state) {
  const usable = projects.filter((p) => p.exists);
  const guide = models.guide;
  let pid = usable.find((p) => p.id === Number(sessionStorage.getItem('hub.lastProject')))?.id ?? usable[0]?.id;
  const s = { agent: 'auto', model: '', effort: '', cls: 'implement', workMode: 'chat', depth: 'normal' };
  const projBox = h('div.stack'), whoBox = h('div.stack'), wayBox = h('div.stack'), advice = h('div.plate.card.tight.stack');
  let modes = [];
  async function drawWay() {
    modes = await api.get(`/workmodes?project=${pid}&agent=${s.agent === 'codex' ? 'codex' : 'claude'}`, true).catch(() => modes);
    wayBox.replaceChildren(workModePicker(modes, s.workMode, (k) => { s.workMode = k; const m = modes.find((x) => x.id === k); if (m) s.cls = m.cls; drawWay(); if (s.agent === 'auto') ask(); }, s.depth, (d) => { s.depth = d; drawWay(); }));
  }

  const drawProject = () => {
    const cur = usable.find((p) => p.id === pid);
    const sel = h('select.select', { 'aria-label': 'Проект', onchange: (e) => { pid = Number(e.target.value); sessionStorage.setItem('hub.lastProject', String(pid)); drawProject(); drawWay(); } }, usable.map((p) => h('option', { value: p.id, selected: p.id === pid }, p.slug)));
    projBox.replaceChildren(
      h('div.row-flex', sel, btn('Открыть папку…', { kind: 'glass', icon: 'folder', onclick: async () => { try { const id = await openFolder(); if (id) { sessionStorage.setItem('hub.lastProject', String(id)); location.reload(); } } catch { /* toast */ } } })),
      cur ? h('div.row-flex', h('span.t-meta.mono.clamp1', { title: cur.root }, cur.root), cur.linked ? chip('Claude и Codex связаны', 'ok') : btn('Связать Claude и Codex', { kind: 'glass', icon: 'handoff', title: 'Одни правила и одни скиллы для обоих агентов', onclick: () => linkProject(cur.id, () => location.reload()) })) : null);
  };

  const drawWho = () => {
    const pickAgent = (k) => { s.agent = k; s.model = ''; drawWho(); drawWay(); if (k === 'auto') ask(); };
    const opts = guide.filter((g) => g.agent === s.agent);
    whoBox.replaceChildren(
      h('div.row-flex', pills([['auto', 'Выбрать самому hub'], ['claude', 'Claude'], ['codex', 'Codex (GPT)']], s.agent, pickAgent, 'Кто работает'),
        s.agent === 'auto' ? null : h('div.field', h('select.select', { 'aria-label': 'Модель', onchange: (e) => { s.model = e.target.value; } }, [h('option', { value: '' }, 'Модель по умолчанию'), ...opts.map((g) => h('option', { value: g.id, selected: s.model === g.id }, g.name))])),
        s.agent === 'auto' ? null : h('div.field', h('select.select', { 'aria-label': 'Глубина мышления', onchange: (e) => { s.effort = e.target.value; } }, EFFORT.map(([v, t]) => h('option', { value: v, selected: s.effort === v }, v ? 'Мышление: ' + t.toLowerCase() : 'Мышление: авто'))))),
      s.agent === 'auto' ? h('div.stack', h('div.field', h('select.select', { 'aria-label': 'Что за задача', onchange: (e) => { s.cls = e.target.value; ask(); } }, TASKS.map(([v, t]) => h('option', { value: v, selected: s.cls === v }, 'Задача: ' + t.toLowerCase())))), advice) : null);
  };
  async function ask() {
    const r = await api.post('/advise', { cls: s.cls }, true).catch(() => null);
    if (!r) return;
    const c = r.choice, e = r.estimate, alt = c.alt;
    advice.replaceChildren(
      h('div.row-flex', agentBadge(c.agent, modelName(guide, c.agent, shortModel(c.agent, c.model))), chip('мышление: ' + (({ low: 'быстро', medium: 'обычно', high: 'глубоко', max: 'максимум' })[c.effort] || c.effort), 'line')),
      h('p', c.reason),
      e?.percent ? h('span.t-meta', pctText(e.percent) + '.') : null,
      alt ? h('div.row-flex', h('span.t-meta', `Можно и ${agentName(alt.agent)}: ${alt.why}`), btn('Взять его', { kind: 'glass', class: 'btn-sm', onclick: () => { s.agent = alt.agent; s.model = shortModel(alt.agent, alt.model); s.effort = alt.effort; drawWho(); } })) : null);
  }

  const ta = h('textarea.textarea', { rows: 3, placeholder: 'Например: «добавь в проект экспорт истории в JSON»', 'aria-label': 'Задача', 'data-autofocus': true });
  const go2 = () => {
    const t = ta.value.trim();
    if (!t) return toast('Напишите, что нужно сделать', 'err');
    const bad = s.agent !== 'auto' && state.agents[s.agent]?.auth?.loggedIn === false;
    if (bad) return toast(`${agentName(s.agent)} не подключён: нажмите «Войти» в блоке «Агенты» справа`, 'err');
    const q = new URLSearchParams({ project: String(pid), prompt: t, send: '1', agent: s.agent, cls: s.cls, workMode: s.workMode });
    if (s.workMode === 'autopilot') q.set('depth', s.depth);
    if (s.model) q.set('model', s.model); if (s.effort) q.set('effort', s.effort);
    go(`/chat?${q}`);
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); go2(); } });

  drawProject(); drawWho(); drawWay(); ask();
  const step = (n, title, ...body) => h('div.step', h('span.step-n', n), h('div.stack.grow', h('b.t-label', title), ...body));
  return h('section.compose-hero.plane.stack', h('h2.t-title', 'Что делаем сегодня?'),
    step('1', 'Где работаем', projBox), step('2', 'Кто работает', whoBox), step('3', 'Как работаем', wayBox), step('4', 'Что нужно сделать', ta),
    h('div.row-flex', { style: { justifyContent: 'flex-end' } }, h('span.t-meta', 'Ctrl+Enter'), btn('Начать', { kind: 'primary', icon: 'send', disabled: !usable.length, onclick: go2 })));
}

async function decision(r, models, proj) {
  const to = r.agent === 'codex' ? 'claude' : 'codex';
  const toModel = to === 'claude' ? models.routing.implement : { model: 'gpt-6.1-sol', effort: 'medium' };
  const detail = await api.get('/runs/' + r.id, true).catch(() => null);
  const card = detail?.card;
  const reset = card?.resetsAt;
  const files = card ? (/files_changed: (\[.*\])/.exec(card.markdown)?.[1] ? JSON.parse(/files_changed: (\[.*\])/.exec(card.markdown)[1]).length : 0) : 0;
  const primary = btn(`Продолжить в ${agentName(to)}`, { kind: 'primary', onclick: async () => { try { const x = await api.post(`/runs/${r.id}/handoff`, { agent: to, model: to === 'claude' ? 'sonnet' : toModel.model, effort: toModel.effort }); go('/chat/' + x.run.id); } catch { /* toast */ } } });
  return h('section.decision', { 'aria-labelledby': 'dec' },
    h('div', h('div.kicker', h('span.dot'), 'Нужно ваше решение'),
      h('h2.t-title#dec', `У ${agentName(r.agent)} кончился лимит`),
      h('p.why', `${proj(r.projectId)} · «${(r.prompt || '').replace(/\s+/g, ' ').slice(0, 110)}»`),
      h('p.why.muted', card ? `Работа сохранена${files ? ` (изменено файлов: ${files})` : ''}. Другой агент продолжит по короткой записи о сделанном, и объяснять заново не придётся.` : 'Записи о сделанном нет: другой агент увидит только исходную задачу.'),
      h('div.row-flex', { style: { marginTop: '14px' } }, h('span.t-meta', 'Предлагаю:'), agentBadge(to, `${agentName(to)} · ${fmt.model(toModel.model)}`))),
    h('div.actions', primary,
      card ? btn('Что запомнили', { kind: 'glass', onclick: () => dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Запись о сделанном'), closeBtn()), h('pre', card.markdown), h('div.foot', btn('Копировать', { kind: 'glass', icon: 'copy', onclick: () => copy(card.markdown) }))), { wide: true }) }) : null,
      reset ? h('span.t-meta', { style: { textAlign: 'center' } }, `или подождать: лимит вернётся ${fmt.until(reset)}`) : null));
}

function welcome(state) {
  const status = h('p.muted', 'Hub читает ваши прошлые разговоры с Claude Code и Codex (ничего в них не меняет) и помогает продолжать работу в любом из них.');
  const imp = btn('Загрузить историю', { kind: 'primary', icon: 'refresh', onclick: async () => {
    imp.disabled = true; status.textContent = 'Загружаю… в первый раз это от 15 до 60 секунд.';
    await api.post('/sync'); const poll = setInterval(async () => { const s = await api.get('/sync', true).catch(() => null); if (s && !s.running) { clearInterval(poll); location.reload(); } }, 1200);
  } });
  return h('section.compose-hero.plane.stack', h('h2.t-title', 'Начнём с папки проекта'), status,
    h('div.row-flex', btn('Открыть папку…', { kind: 'primary', icon: 'folder', onclick: () => addProjectDialog((id) => go('/p/' + id)) }), imp),
    h('div.stack', h('b.t-label', 'Агенты'), ...['claude', 'codex'].map((id) => agentCard({ id, ...state.agents[id] }, { onChange: () => location.reload() }))));
}
