import { api, qs } from '../api.js';
import { agentBadge, agentName, btn, chip, dialog, closeBtn, empty, field, fmt, h, icon, sectionHead, toast } from '../ui.js';
import { go, linkProject, pageHead, pctText, runRow, sessionRow, shortModel, TASKS } from './common.js';
import { chatPanel } from './chat.js';
import { historyPanel } from './history.js';
import { reviewLink, reviewLinks } from './review.js';
import { toolsPanel } from './tools.js';
import { logsPanel } from './logs.js';

const TABS = [['', 'Обзор', 'today'], ['chat', 'Чат', 'chat'], ['tasks', 'Задачи', 'task'], ['history', 'История', 'history'], ['tools', 'Инструменты', 'library'], ['logs', 'Журнал', 'logs']];

export default async function view(ctx) {
  const id = Number(ctx.params[0]), tab = ctx.params[1] || '', extra = ctx.params[2];
  const o = await api.get('/projects/' + id);
  const p = o.project;
  let body, cleanup;
  if (tab === 'library') { location.replace(`#/p/${id}/tools`); return { title: p.slug, node: h('div') }; }
  if (tab === 'chat') { const c = await chatPanel({ projectId: id, runId: extra, q: ctx.q }); body = c.node; cleanup = c.cleanup; }
  else if (tab === 'tasks') body = await tasks(id, o);
  else if (tab === 'history') { const x = historyPanel({ projectId: id }); body = x.node; }
  else if (tab === 'tools') { const x = await toolsPanel({ projectId: id, initialTab: ctx.q.get('tab') || (extra === 'find' ? 'find' : undefined) }); body = x.node; cleanup = x.cleanup; }
  else if (tab === 'logs') { const x = logsPanel({ projectId: id }); body = x.node; cleanup = x.cleanup; }
  else body = overview(id, o);
  const tabs = h('nav.subtabs.glass', { 'aria-label': 'Разделы проекта' }, TABS.map(([k, t, ic]) => h('a.pill', { href: `#/p/${id}${k ? '/' + k : ''}`, 'aria-selected': String(k === tab) }, icon(ic, 'sm'), t)));
  const linked = !!o.hub;
  return { title: p.slug, cleanup, node: h('div', pageHead({ crumbs: [{ text: 'Проекты', href: '/projects' }], title: p.slug, sub: h('span.mono.t-meta', p.root),
    actions: h('div.row-flex', p.exists ? null : chip('папка не найдена', 'warn'), p.exists && !linked ? btn('Связать Claude и Codex', { kind: 'glass', icon: 'handoff', onclick: () => linkProject(id, () => location.reload()) }) : null, linked ? chip('Claude и Codex связаны', 'ok') : null, btn('Новый чат', { kind: 'primary', icon: 'chat', onclick: () => go(`/p/${id}/chat`) })) }), tabs, body) };
}

const STATE_RU = { approved: ['готово', 'ok'], ready: ['ждёт вашего «да»', 'warn'], current: ['сейчас', 'info'], blocked: ['позже', 'line'] };

/** Everything about one step: what it is, who does what, which files appear. Opens from the stepper. */
function stageDialog(id, s, prev) {
  const st = STATE_RU[s.state] || STATE_RU.blocked;
  const close = () => document.getElementById('dlg').close();
  const startChat = () => { close(); const q = new URLSearchParams({ prompt: s.starter, cls: s.taskClass }); go(`/p/${id}/chat?${q}`); };
  const approve = async () => { try { await api.post('/stages/approve', { projectId: id, stage: s.id }); toast('Шаг подтверждён', 'ok'); close(); location.reload(); } catch { /* toast */ } };
  const row = (k, t) => h('div.stage-line', h('b.t-label', k), h('span', t));
  dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', `Шаг ${s.id}. ${s.title}`), h('div.row-flex', { style: { marginTop: '6px' } }, chip(st[0], st[1]))), closeBtn()),
    h('p', s.help), row('Вы делаете', s.you), row('Агент делает', s.agent),
    h('div.stack', { style: { gap: '6px' } }, h('b.t-label', 'Что должно появиться'), h('div.row-flex', s.outputs.map((f) => chip((s.present.includes(f) ? '✔ ' : '○ ') + f, s.present.includes(f) ? 'ok' : 'line')))),
    s.skills.length ? h('p.t-meta', 'Помогают скиллы: ' + s.skills.join(', ') + '. Если какого-то нет, агент справится и без него.') : null,
    s.state === 'blocked' && prev ? h('p.t-meta', `${s.early ? 'Файлы для этого шага уже есть. ' : ''}Подтвердить его можно после шага ${prev.id} «${prev.title}».`) : null,
    s.state === 'approved' ? h('p.t-meta', 'Подтверждён ' + fmt.date(s.approvedAt)) : null,
    h('div.foot', btn('Закрыть', { kind: 'glass', onclick: close }),
      s.key === 'toolkit' ? btn('Открыть инструменты', { kind: 'glass', onclick: () => { close(); go(`/p/${id}/tools`); } }) : s.starter && s.state !== 'approved' ? btn('Начать в чате', { kind: s.state === 'ready' ? 'glass' : 'primary', icon: 'chat', onclick: startChat }) : null,
      s.state === 'ready' ? btn('Подтвердить шаг', { kind: 'primary', icon: 'check', onclick: approve }) : s.state !== 'approved' && s.missing.length ? h('span.t-meta', { style: { alignSelf: 'center' } }, 'Подтвердить можно, когда появятся: ' + s.missing.join(', ')) : null)), { wide: true });
}

function overview(id, o) {
  const cur = o.stages.find((s) => s.state !== 'approved');
  // A later step may already have its files (for example the tools step after setup); only the first unfinished step is "current".
  o = { ...o, stages: o.stages.map((s) => (s.state === 'ready' && s !== cur ? { ...s, state: 'blocked', early: true } : s)) };
  const stepper = o.stages.length ? h('div.stages', o.stages.map((s, i) => h('button.stage.plate', { type: 'button', dataset: { state: s.state }, title: STATE_RU[s.state]?.[0], 'aria-label': `Шаг ${s.id}: ${s.title}, ${STATE_RU[s.state]?.[0]}. Открыть описание`, onclick: () => stageDialog(id, s, o.stages[i - 1]) },
    h('span.num', s.state === 'approved' ? icon('check', 'sm') : s.id), h('b', s.title)))) : h('p.muted', 'Шаги появятся, когда папка проекта доступна.');
  const cs = cur ? (STATE_RU[cur.state] || STATE_RU.current) : null;
  const stageCard = cur ? h('div.plane.card.stack',
    h('div.row-flex', chip(`Сейчас шаг ${cur.id} из ${o.stages.length}`, 'soft'), chip(cs[0], cs[1])),
    h('h3.t-title', cur.title), h('p.muted', cur.help),
    h('div.stage-line', h('b.t-label', 'Вы'), h('span', cur.you)), h('div.stage-line', h('b.t-label', 'Агент'), h('span', cur.agent)),
    h('div.row-flex', cur.outputs.map((f) => chip((cur.present.includes(f) ? '✔ ' : '○ ') + f, cur.present.includes(f) ? 'ok' : 'line'))),
    h('div.row-flex', btn('Открыть шаг', { kind: 'primary', onclick: () => stageDialog(id, cur, o.stages[cur.id - 2]) }))) : h('div.plane.card', h('b', 'Все шаги пройдены'));
  const tk = o.toolkit;
  return h('div.stack',
    !o.hub && o.project.exists ? h('div.alert.info', icon('info'), h('div.stack', { style: { flex: 1 } }, h('b', 'Claude и Codex пока не связаны с этой папкой'), h('span', 'Сейчас у каждого свои правила и свои скиллы. Кнопка создаст один файл правил и общий набор скиллов. Сначала вы увидите список файлов.'), h('div', btn('Связать Claude и Codex', { kind: 'primary', onclick: () => linkProject(id, () => location.reload()) })))) : null,
    h('section.group', sectionHead('Путь проекта', h('span.t-meta', '8 шагов от идеи до итогов. Нажмите на шаг, чтобы увидеть, что в нём делается.')), stepper), h('div.grid-2', stageCard,
      h('div.stack', h('div.plane.card.tight.stack', h('b.t-label', 'Инструменты проекта'), h('div.row-flex', chip(tk ? `подключено: ${tk.selected.length}` : 'пока не выбраны', tk ? 'ok' : 'warn'), o.tokens ? chip(`≈ ${fmt.tok(o.tokens)} токенов на сообщение`, 'line') : null), h('p.t-meta', 'Скиллы, плагины и MCP: что подключено именно здесь и сколько это стоит.'), btn('Открыть инструменты', { kind: 'glass', onclick: () => go(`/p/${id}/tools`) })))),
    h('div.grid-2', h('section.group', sectionHead('Недавние разговоры', h('a.btn.btn-text.btn-sm', { href: `#/p/${id}/history` }, 'Вся история')), o.sessions.length ? h('div.list', o.sessions.map(sessionRow)) : empty('Разговоров пока нет')),
      h('section.group', sectionHead('Запущено из панели'), o.runs.length ? h('div.list', o.runs.map((r) => runRow(r, `#/p/${id}/chat/${r.id}`))) : empty('Пока ничего', 'Начните чат, и он появится здесь.'))));
}

async function tasks(id, o) {
  const runs = (await api.get('/runs' + qs({ project: id, limit: 60 }))).filter((r) => r.branch);
  const links = await reviewLinks(runs);
  const name = h('input.input', { placeholder: 'например, export-json', 'aria-label': 'Название задачи', maxLength: 40 });
  const prompt = h('textarea.textarea', { rows: 3, placeholder: 'Что нужно сделать?', 'aria-label': 'Описание задачи' });
  const cls = h('select.select', { 'aria-label': 'Тип задачи', onchange: advise }, TASKS.filter(([v]) => v !== 'summary').map(([v, t]) => h('option', { value: v }, t)));
  const sec = h('input.check', { type: 'checkbox', 'aria-label': 'Касается безопасности', onchange: advise });
  const sparse = h('input.input', { placeholder: 'src, docs (пусто: весь проект)', 'aria-label': 'Только эти папки' });
  const sparseList = () => sparse.value.split(',').map((x) => x.trim()).filter(Boolean);
  const adv = h('div.plate.card.tight.stack');
  let choice = null;
  async function advise() {
    const r = await api.post('/advise', { cls: cls.value, securityBoundary: sec.checked }, true).catch(() => null);
    if (!r) return; choice = r.choice; const e = r.estimate;
    adv.replaceChildren(h('div.row-flex', agentBadge(choice.agent, `${agentName(choice.agent)} · ${fmt.model(choice.model)}`)), h('p.t-meta', choice.reason),
      h('div.row-flex', e.usd ? chip(`≈ $${e.usd.low}–$${e.usd.high}`, 'line') : null, e.percent ? chip(pctText(e.percent), 'line') : chip('расход лимита пока не известен', 'warn')));
  }
  advise();
  const start = async () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.value)) return toast('Название: латиница, цифры, точка и дефис, например export-json', 'err');
    if (!prompt.value.trim()) return toast('Опишите, что нужно сделать', 'err');
    try { const r = await api.post('/runs', { projectId: id, prompt: prompt.value, agent: choice.agent, model: shortModel(choice.agent, choice.model), effort: choice.effort, mode: 'task', task: name.value, cls: cls.value, ...(sparseList().length ? { sparse: sparseList() } : {}) }); go(`/p/${id}/chat/${r.run.id}`); } catch { /* toast */ }
  };
  return h('div.grid-2',
    h('section.group', sectionHead('Задачи в своих ветках', h('span.t-meta', 'ваши файлы не затрагиваются, пока вы не примете результат')), runs.length ? h('div.list', runs.map((r) => (links.has(r.id) ? h('div.rv-task', runRow(r, `#/p/${id}/chat/${r.id}`), reviewLink(id, r, links.get(r.id))) : runRow(r, `#/p/${id}/chat/${r.id}`)))) : empty('Задач пока нет', 'Опишите первую справа. Агент поработает в отдельной ветке git, а результат вы посмотрите и примете сами.')),
    h('section.plane.card.stack', h('h3.t-heading', 'Новая задача'), field('Название', name), field('Что сделать', prompt),
      h('div.row-flex', field('Тип', cls), h('label.row-flex', { style: { alignSelf: 'flex-end', minHeight: '44px' } }, sec, h('span.t-label', 'Касается безопасности'))),
      field('Показать агенту только эти папки (необязательно)', sparse), h('b.t-label', 'Кого и зачем советуем'), adv,
      o.project.exists ? btn('Запустить', { kind: 'primary', icon: 'branch', onclick: start }) : h('p.t-meta', 'Папка проекта не найдена')));
}
