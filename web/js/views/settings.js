import { api, prefs } from '../api.js';
import { btn, chip, fmt, h, pills, sectionHead, toast } from '../ui.js';
import { dialog, closeBtn } from '../ui.js';
import { agentCard, pageHead } from './common.js';

export default async function view() {
  const [s, cfg, sh] = await Promise.all([api.get('/state'), api.get('/config'), api.get('/sharing')]);

  // ---- look
  const themeBox = h('div'), accentBox = h('div'), matBox = h('div');
  const draw = () => {
    const c = prefs.get();
    themeBox.replaceChildren(pills([['dark', 'Тёмная'], ['light', 'Светлая']], c.theme || 'dark', (k) => { prefs.set({ theme: k }); draw(); }, 'Тема'));
    accentBox.replaceChildren(pills([['green', 'Зелёный'], ['orange', 'Оранжевый']], c.accent || 'green', (k) => { prefs.set({ accent: k }); draw(); }, 'Цвет акцентов'));
    matBox.replaceChildren(pills([['glass', 'Стекло'], ['opaque', 'Сплошной']], c.material === 'opaque' ? 'opaque' : 'glass', (k) => { prefs.set({ material: k }); draw(); }, 'Фон панелей'));
  };
  draw();

  // ---- agents
  const agentsBox = h('div.stack');
  const drawAgents = (st) => agentsBox.replaceChildren(...['claude', 'codex'].map((id) => agentCard({ id, ...st.agents[id] }, { onChange: async () => drawAgents(await api.get('/state')) })));
  drawAgents(s);

  // ---- history import
  const syncOut = h('span.t-meta', s.sync?.last ? `Обновлено ${fmt.ago(s.sync.last.at)}` : 'Ещё не загружали');
  const syncBtn = btn('Обновить историю', { kind: 'glass', icon: 'refresh', onclick: async () => {
    syncBtn.disabled = true; await api.post('/sync');
    const t = setInterval(async () => { const x = await api.get('/sync', true).catch(() => null); if (x && !x.running) { clearInterval(t); syncBtn.disabled = false; syncOut.textContent = x.error ? 'Не получилось: ' + x.error : 'Готово: история обновлена'; toast('История обновлена', 'ok'); } }, 1000);
  } });

  // ---- extra skill folders
  const rootsBox = h('div.stack');
  const rootInput = h('input.input', { placeholder: 'Например: C:\\Users\\вы\\Desktop\\мои-скиллы', 'aria-label': 'Папка со скиллами', style: { flex: 1, minWidth: '220px' } });
  const drawRoots = (list) => rootsBox.replaceChildren(...(list.length ? list.map((r) => h('div.set-row', h('span.mono.t-meta.clamp1', { title: r.path || r }, r.path || r), btn('Убрать', { kind: 'glass', onclick: async () => { const x = await api.post('/config/skill-root', { path: r.path || r, remove: true }); drawRoots(x.extraSkillRoots); } }))) : [h('p.t-meta', 'Своих папок пока нет.')]));
  drawRoots(cfg.extraSkillRoots);
  const addRoot = async () => { if (!rootInput.value.trim()) return; try { const x = await api.post('/config/skill-root', { path: rootInput.value.trim() }); drawRoots(x.extraSkillRoots); rootInput.value = ''; toast('Папка добавлена: её скиллы появятся в «Инструментах»', 'ok'); } catch { /* api shows the toast */ } };

  // ---- help improve forecasts (opt-in; nothing is ever sent by the app)
  const shareBox = h('div.stack');
  const state = { consent: sh.consent };
  const showSample = async () => {
    const p = await api.get('/cases/preview?limit=5');
    dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', 'Что попадёт в файл'), h('p.t-meta', `Всего записей: ${p.count}. Вот последние ${p.sample.length}.`)), closeBtn()),
      h('p.t-meta', 'Никогда не попадает: ' + p.neverIncluded.join('; ') + '.'), h('pre', { style: { maxHeight: '320px' } }, JSON.stringify(p.sample, null, 1)),
      h('div.foot', btn('Закрыть', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }))), { wide: true });
  };
  const drawShare = () => shareBox.replaceChildren(
    h('label.row-flex', { style: { minHeight: '44px', alignItems: 'flex-start' } }, h('input.check', { type: 'checkbox', checked: state.consent, onchange: async (e) => { try { await api.post('/sharing', { consent: e.target.checked }); state.consent = e.target.checked; toast(state.consent ? 'Спасибо! Файл можно сохранить кнопкой ниже' : 'Согласие снято: сохранение файла отключено', 'ok'); } catch { e.target.checked = state.consent; } drawShare(); } }),
      h('span', 'Я согласен(на) поделиться анонимной статистикой о задачах: тип задачи, модель, расход токенов, получилось или нет.')),
    h('div.row-flex', btn('Посмотреть, что попадёт', { kind: 'glass', onclick: showSample }), btn('Сохранить файл', { kind: 'primary', disabled: !state.consent, onclick: async () => { try { const r = await api.post('/cases/export'); toast(`Сохранено записей: ${r.count}. Файл: ${r.path}`, 'ok'); } catch { /* toast */ } } }), state.consent ? chip('согласие дано', 'ok') : chip('выключено', 'line')));
  drawShare();

  return { title: 'Настройки', node: h('div', pageHead({ title: 'Настройки' }),
    h('div.stack',
      h('section.plane.card.stack', sectionHead('Агенты'), h('p.t-meta', 'Чтобы работать из панели, каждый агент должен быть установлен и войти в аккаунт. Вход делается один раз.'), agentsBox),
      h('section.plane.card', sectionHead('Внешний вид'), h('div.set-row', h('span.t-label', 'Тема'), themeBox), h('div.set-row', h('span.t-label', 'Цвет акцентов'), accentBox), h('div.set-row', h('div', h('span.t-label', 'Фон панелей'), h('p.t-meta', 'Сплошной подойдёт для слабых компьютеров и если плохо видно текст.')), matBox)),
      h('section.plane.card', sectionHead('История'), h('div.set-row', h('div', h('span.t-label', 'Разговоры из Claude и Codex'), h('p.t-meta', 'Hub читает их файлы и ничего в них не меняет. Обновляйте, когда хотите увидеть свежие разговоры.')), h('div.stack', { style: { alignItems: 'flex-end', gap: '6px' } }, syncBtn, syncOut))),
      h('section.plane.card', sectionHead('Свои папки со скиллами'), h('p.t-meta', 'Если у вас есть собственные скиллы (например, ваш пайплайн дизайна), добавьте папку: они появятся в «Инструментах» и будут стоить 0, пока не подключены к проекту. Hub их только читает.'), rootsBox, h('div.row-flex', { style: { marginTop: '10px' } }, rootInput, btn('Добавить', { kind: 'glass', icon: 'plus', onclick: addRoot }))),
      h('section.plane.card.stack', sectionHead('Помочь улучшить прогнозы'),
        h('p.t-meta', `Hub и так учится на ваших задачах прямо на этом компьютере. Если хотите помочь сделать прогнозы точнее для всех, включите согласие: тогда можно сохранить файл со статистикой и отправить его сами. Сейчас записей: ${sh.caseCount}. Приложение ничего не отправляет само.`),
        h('p.t-meta', 'В файл не попадают: ' + sh.neverIncluded.join('; ') + '. Числа округляются. Согласие можно снять в любой момент.'), shareBox),
      h('section.plane.card', sectionHead('Безопасность'), h('ul.muted', { style: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '6px' } },
        h('li', 'Панель доступна только на этом компьютере и только по вашей ссылке.'),
        h('li', 'Агентам нельзя делать git push.'),
        h('li', 'Файлы в проекте меняются только после того, как вы увидели список и подтвердили. Перед записью делается копия, изменение можно отменить.'),
        h('li', 'Тексты из каталогов и чужих файлов hub считает данными, а не командами.'))),
      h('p.t-meta', `Agent Hub ${s.version} · данные панели: ${s.home}`))) };
}
