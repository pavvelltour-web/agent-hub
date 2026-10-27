import { api, prefs } from '../api.js';
import { btn, chip, empty, field, fmt, h, pills, sectionHead, toast } from '../ui.js';
import { dialog, closeBtn } from '../ui.js';
import { agentCard, pageHead } from './common.js';

export default async function view() {
  const [s, cfg, sh, pr, oc] = await Promise.all([api.get('/state'), api.get('/config'), api.get('/sharing'), api.get('/prices'), api.get('/outcomes').catch(() => null)]);

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

  // ---- subscription: the share of the weekly limit one SOLVED task costs is the main number; dollars are only for comparing
  const SUB = { manual: 'Как вы выбирали сами', router: 'Выбор hub' };
  const subRows = (oc?.strategies || []).filter((r) => SUB[r.strategy]);
  const pctBig = (v) => (typeof v === 'number' ? '≈ ' + (v < 0.1 ? '<0,1' : (Math.round(v * 10) / 10).toLocaleString('ru-RU')) + '%' : '—');
  const subBox = subRows.some((r) => r.n > 0) ? h('div.grid-2', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' } }, subRows.map((r) => h('div.plate.card.tight.stack',
    h('span.t-meta', SUB[r.strategy]), h('b.t-title', pctBig(r.limitPctPerSolved)),
    h('span.t-meta', typeof r.limitPctPerSolved === 'number' ? 'недельного лимита на одну решённую задачу' : 'доля лимита пока не известна: нужны замеры остатка (впишите его на экране «Модели»)'),
    h('span.t-meta', (typeof r.costPerSolved === 'number' ? `по цене API ≈ $${r.costPerSolved < 0.01 ? '<0.01' : r.costPerSolved.toFixed(2)}` : 'цена по API не известна') + ` · попыток: ${r.n}`), r.n ? h('div.row-flex', chip(r.label === 'measured' ? 'замерено' : 'прикидка', r.label === 'measured' ? 'ok' : 'warn')) : null)))
    : empty('Пока нечего считать', 'Когда вы запустите несколько задач и они закончатся, здесь появится, сколько недельного лимита уходит на одну решённую задачу.');

  // ---- prices (editable): every row says where it came from; your own numbers win over the bundled ones
  const pricesBox = h('div.stack');
  const noticeBox = h('div.stack', { role: 'status' });
  const drawNotice = (x) => noticeBox.replaceChildren(
    ...(x.overrideProblem ? [h('p.plate.card.tight', { style: { margin: 0 } }, chip('ваши цены не используются', 'err'), ' ', x.overrideProblem + '. Пока это так, в расчётах стоят цены из каталога, а новые правки не сохранятся.')] : []),
    ...(x.rejectedRows?.length ? [h('div.plate.card.tight.stack', h('div.row-flex', chip(`строк отброшено: ${x.rejectedRows.length}`, 'warn')), h('ul', { style: { margin: 0, paddingLeft: '20px' } }, x.rejectedRows.slice(0, 10).map((r) => h('li', h('b', r.id), ': ' + r.reason))))] : []));
  drawNotice(pr);
  const num = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : NaN);
  const drawPrices = (list) => pricesBox.replaceChildren(...list.map((m) => {
    const t = m.tiers[0], single = m.tiers.length === 1;
    const ins = single ? ['input', 'cacheRead', 'output'].map((k) => h('input.input', { type: 'number', min: 0.0001, max: 10000, step: 'any', value: String(t[k]), 'aria-label': m.id + ': ' + ({ input: 'вход', cacheRead: 'из кэша', output: 'выход' })[k] + ', доллары за миллион токенов', style: { width: '110px' } })) : [];
    const lbl = ['Вход', 'Из кэша', 'Выход'];
    const save = async () => { const v = ins.map((i) => num(i.value)); if (v.some((x) => Number.isNaN(x) || x <= 0)) return toast('Цена — число больше нуля', 'err'); try { const x = await api.post('/prices', { model: m.id, input: v[0], cacheRead: v[1], output: v[2] }); drawPrices(x.models); drawNotice(x); toast('Цена сохранена', 'ok'); } catch { /* toast */ } };
    const reset = async () => { try { const x = await api.post('/prices', { model: m.id, reset: true }); drawPrices(x.models); drawNotice(x); toast('Вернули цену из каталога', 'ok'); } catch { /* toast */ } };
    return h('div.plate.card.tight.stack', h('div.row-flex', h('b', m.label || m.id), m.overridden ? chip('ваша цена', 'info') : null),
      single ? h('div.row-flex', ins.map((i, n) => field(lbl[n] + ', $ за 1 млн', i))) : h('p.muted', { style: { margin: 0 } }, 'Цена зависит от длины запроса: ' + m.tiers.map((x) => `${x.promptTokensUpTo ? 'до ' + x.promptTokensUpTo.toLocaleString('ru-RU') + ' токенов' : 'дальше'}: $${x.input} / $${x.cacheRead} / $${x.output}`).join('; ') + '. Менять можно в файле prices.json в папке данных.'),
      h('p.t-meta', `${m.source} · ${m.dateKind === 'recorded' ? 'записано в плане ' : m.dateKind === 'user' ? 'вписано ' : 'проверено '}${m.date.split('-').reverse().join('.')}`),
      h('div.row-flex', single ? btn('Сохранить', { kind: 'glass', onclick: save }) : null, m.overridden ? btn('Вернуть из каталога', { kind: 'glass', onclick: reset }) : null));
  }));
  drawPrices(pr.models);

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
      h('section.plane.card.stack', sectionHead('Подписка'), h('p.muted', { style: { margin: 0 } }, 'Подписка не списывает деньги за токены, у неё недельный лимит. Поэтому главное число — какая доля лимита уходит на одну решённую задачу. Доллары по цене API нужны только чтобы сравнивать варианты.'), subBox, h('a.btn.btn-text', { href: '#/models' }, 'Сравнение способов выбора модели')),
      h('section.plane.card.stack', sectionHead('Цены моделей'), h('p.muted', { style: { margin: 0 } }, 'Цены по API за миллион токенов: нужны, чтобы сравнивать модели между собой. Если цена изменилась, впишите свою: она важнее цены из каталога. Модель без цены считается «не известна», а не бесплатной; цена 0 не принимается.'), noticeBox, pricesBox),
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
