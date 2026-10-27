import { api } from '../api.js';
import { btn, chip, closeBtn, dialog, empty, fmt, h, icon, toast } from '../ui.js';
import { addProjectDialog, agentCard, go, pageHead, planDialog, TYPES } from './common.js';

/** First run: Агенты → История → Первый проект → Набор скиллов. Every step can be skipped; nothing is written without the user's confirmation. */
export const WELCOME_DONE = 'hub.welcomeDone';
const STEPS = [['agents', 'Агенты', 'Агенты'], ['history', 'История', 'История'], ['project', 'Первый проект', 'Проект'], ['skills', 'Набор скиллов', 'Скиллы']];

export default async function view({ q }) {
  let step = Math.max(0, STEPS.findIndex(([k]) => k === q.get('step')));
  let timer = null;
  const body = h('div.stack');
  const nav = h('ol.wz-steps', { 'aria-label': 'Шаги первого запуска' });
  const finish = () => { try { localStorage.setItem(WELCOME_DONE, '1'); } catch { /* private mode: the page shows again, that is fine */ } go('/'); };
  const next = () => { if (step < STEPS.length - 1) { step++; draw(); } else finish(); };
  const foot = (primary) => h('div.row-flex.wz-foot',
    primary,
    btn(step < STEPS.length - 1 ? 'Пропустить шаг' : 'Закончить', { kind: 'glass', onclick: next }),
    step > 0 ? btn('Назад', { kind: 'text', icon: 'back', onclick: () => { step--; draw(); } }) : null);

  function drawNav() {
    nav.replaceChildren(...STEPS.map(([k, , short], i) => h('li', h('button.wz-step', { type: 'button', 'aria-current': i === step ? 'step' : null, 'data-done': i < step ? '1' : null, onclick: () => { step = i; draw(); } },
      h('span.step-n', i < step ? icon('check', 'sm') : String(i + 1)), h('span.wz-short', short)))));
  }

  const panes = {
    async agents() {
      const st = await api.get('/state');
      const box = h('div.stack');
      const paint = (s) => box.replaceChildren(...['claude', 'codex'].map((id) => agentCard({ id, ...s.agents[id] }, { onChange: async () => paint(await api.get('/state')) })));
      paint(st);
      return [h('p.muted', 'Hub работает через Claude Code и Codex, которые уже стоят на этом компьютере. Войдите хотя бы в одного. Пароли hub не видит и не хранит.'), box, foot(btn('Дальше', { kind: 'primary', onclick: next }))];
    },
    async history() {
      const out = h('p.t-meta');
      const s0 = await api.get('/sync');
      const show = (s) => { out.textContent = s?.running ? 'Загружаю… в первый раз это от 15 до 60 секунд.' : s?.error ? 'Не получилось: ' + s.error : s?.last ? `Готово: разговоров ${s.last.claude.sessions + s.last.codex.sessions}, сообщений ${s.last.claude.messages + s.last.codex.messages} (${fmt.ago(s.last.at)}).` : 'Ещё не загружали.'; };
      show(s0);
      const go1 = btn('Загрузить историю', { kind: 'primary', icon: 'refresh', onclick: async () => {
        go1.disabled = true; show({ running: true });
        try { await api.post('/sync'); } catch { go1.disabled = false; show(null); return; }
        timer = setInterval(async () => { const s = await api.get('/sync', true).catch(() => null); if (s && !s.running) { clearInterval(timer); timer = null; go1.disabled = false; show(s); } }, 1200);
      } });
      if (s0.running) go1.disabled = true;
      return [h('p.muted', 'Hub читает ваши прошлые разговоры с Claude Code и Codex, чтобы искать по ним и продолжать работу в любом из агентов. В самих разговорах ничего не меняется.'), h('div.row-flex', go1), out, foot(btn('Дальше', { kind: 'glass', onclick: next }))];
    },
    async project() {
      const projects = await api.get('/projects');
      const open = btn('Открыть папку…', { kind: 'primary', icon: 'folder', onclick: () => addProjectDialog(() => { toast('Проект добавлен', 'ok'); step++; draw(); }) });
      const fresh = btn('Новый по шаблону…', { kind: 'glass', icon: 'plus', onclick: () => newProjectDialog(() => { toast('Проект создан. Команда проверки из шаблона ещё не одобрена: hub покажет её перед первым запуском.', 'ok'); step++; draw(); }) });
      return [h('p.muted', 'Проект — папка с вашей работой. Hub ничего в ней не меняет, пока вы сами не подтвердите список файлов. Можно открыть готовую папку или создать новый проект по шаблону.'),
        h('div.row-flex', open, fresh),
        projects.length ? h('p.t-meta', `Уже добавлено проектов: ${projects.length}.`) : null,
        foot(btn('Дальше', { kind: 'glass', onclick: next }))];
    },
    async skills() {
      const { items, home } = await api.get('/starter');
      const picked = new Set(items.filter((i) => i.checked).map((i) => i.id));
      const apply = btn('Показать, что установится', { kind: 'primary', onclick: async () => {
        const ids = [...picked];
        if (!ids.length) { toast('Отметьте хотя бы один скилл'); return; }
        let r; try { r = await api.post('/starter/plan', { ids }); } catch { return; }
        const skipped = (r.skipped || []).map((s) => `${s.id}: ${s.reason}`);
        planDialog({ title: 'Набор скиллов', r: { ...r, notes: [...skipped, ...(r.notes || [])] }, apply: async () => { const a = await api.post('/starter/apply', { ids, digest: r.digest, approved: true }); toast(`В библиотеке: ${a.installed.join(', ')}. Агентам они не видны, пока вы не подключите их к проекту.`, 'ok'); step = STEPS.length - 1; draw(); return a; } });
      } });
      const rows = items.map((i) => {
        const can = i.state === 'available';
        const box = h('input.check', { type: 'checkbox', checked: picked.has(i.id), disabled: !can, 'aria-label': i.id, onchange: (e) => { e.target.checked ? picked.add(i.id) : picked.delete(i.id); } });
        return h('label.plate.wz-skill', box, h('div.stack', { style: { gap: '4px' } },
          h('div.row-flex', h('b', i.id), chip(i.license === 'unknown' ? 'лицензия не указана' : i.license, i.licenseKnown ? 'line' : 'warn'),
            i.state === 'installed' ? chip('уже есть', 'ok') : i.state === 'manual' ? chip('ставится вручную', 'soft') : null),
          h('span.t-meta', i.why),
          i.state === 'manual' ? h('span.t-meta', i.installCommand ? h('code.mono', i.installCommand) : i.note) : null));
      });
      return [h('p.muted', 'Скиллы кладутся в библиотеку hub и не стоят ни одного токена, пока вы не подключите их к проекту. Перед записью вы увидите все файлы и версию источника.'),
        h('p.t-meta', 'Папка: ', h('span.mono', home + '\\skills')),
        rows.length ? h('div.stack', rows) : empty('Список пуст'), foot(apply)];
    },
  };

  async function draw() {
    try { history.replaceState(null, '', `#/welcome?step=${STEPS[step][0]}`); } catch { /* the step is only remembered for a reload */ }
    drawNav();
    clearInterval(timer); timer = null;
    const [key, title] = STEPS[step];
    body.replaceChildren(h('h2.t-title', `${step + 1}. ${title}`), h('div.skeleton', { style: { height: '56px' } }));
    let parts; try { parts = await panes[key](); } catch (e) { parts = [h('div.alert.err', icon('alert'), h('span', 'Не удалось загрузить шаг: ' + (e.message || e))), foot(btn('Дальше', { kind: 'glass', onclick: next }))]; }
    body.replaceChildren(h('h2.t-title', `${step + 1}. ${title}`), ...parts);
  }
  await draw();

  return { title: 'Первый запуск', cleanup: () => clearInterval(timer), node: h('div',
    pageHead({ title: 'Добро пожаловать', sub: 'Четыре коротких шага. Любой можно пропустить и вернуться позже.', actions: btn('Пропустить всё', { kind: 'glass', onclick: finish }) }),
    h('section.plane.wz', nav, body)) };
}

/** "Новый по шаблону": type + a NEW or empty folder → the plan (every file, the one `git init` command) → confirm. Nothing is written before the confirmation. */
function newProjectDialog(onCreated) {
  const sel = h('select.select', { 'aria-label': 'Тип проекта' }, TYPES.map(([v, t]) => h('option', { value: v }, t)));
  const input = h('input.input', { placeholder: 'C:\\Users\\вы\\Desktop\\мой-проект', 'aria-label': 'Папка нового проекта' });
  const pick = async () => { try { const r = await api.post('/new/pick'); if (r.path) input.value = r.path; } catch { /* api shows the toast */ } };
  const show = async () => {
    const path = input.value.trim();
    if (!path) { toast('Укажите папку для нового проекта'); return; }
    let r; try { r = await api.post('/new/plan', { type: sel.value, path }); } catch { return; }
    document.getElementById('dlg').close();
    planDialog({ title: 'Новый проект', r: { ...r, notes: [...r.notes] }, apply: async () => { const a = await api.post('/new/apply', { type: sel.value, path, approved: true }); onCreated(a.id); return a; } });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') show(); });
  dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Новый проект по шаблону'), closeBtn()),
    h('p.muted', 'Hub создаст каркас: бриф, схему архитектуры, правила для агентов, git и скиллы для этого типа. Папка должна быть новой или пустой: к существующей работе ничего не добавляется.'),
    h('div.field', h('label', 'Что за проект'), sel),
    h('div.field', h('label', 'Папка'), h('div.row-flex', input, btn('Выбрать…', { kind: 'glass', icon: 'folder', onclick: pick }))),
    h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), btn('Показать, что создастся', { kind: 'primary', onclick: show }))));
}
