// Review screen (/p/:id/review/:reviewId) and the review card of a finished task run. Every word from the model or the repository is
// rendered through h()/textContent after model() has typed it (ADR-012); each row is drawn inside try/catch so one bad finding cannot blank the page.
import { api } from '../api.js';
import { btn, chip, closeBtn, dialog, field, h, icon, toast } from '../ui.js';
import {
  ANSWER_RU, EFFORTS, EFFORT_RU, IN_PROGRESS, RISK_RU, ROUND_CAP, SEV_RU, STATE_RU, STEPS, STEP_TEXT,
  blockers, cardText, closedCount, countsText, errRu, groupByFile, model, nothingFound, pick, plural, reasonRu, redCheck, riskWhyRu, short, stepStates, str, votesText, warnRu,
} from '../review-model.js';
import { go, pageHead } from './common.js';

const POLL_MS = 2000;
const safe = (fn, label) => { try { return fn(); } catch { return h('div.rv-bad', label); } };
const chipOf = (table, key, fallback = ['—', 'line']) => { const [t, tone] = pick(table, key) ?? fallback; return chip(t, tone); };
const stateLabel = (m) => {
  const s = m.review.state;
  if (s === 'open' && (redCheck(m) || m.reasons.length)) return ['Не завершено', 'err'];
  return STATE_RU[s];
};

export default async function view(ctx) {
  const pid = Number(ctx.params[0]), rid = ctx.params[1];
  const raw0 = await api.get('/reviews/' + rid);
  const m0 = model(raw0);
  if (!m0.review.id) throw new Error('Ревью не найдено');
  const projectId = m0.review.projectId || pid;
  const [proj, runInfo] = await Promise.all([api.get('/projects/' + projectId, true).catch(() => null), m0.review.runId ? api.get('/runs/' + m0.review.runId, true).catch(() => null) : null]);
  const slug = str(proj?.project?.slug, 80) || 'проект';
  const run = runInfo?.run && typeof runInfo.run === 'object' ? runInfo.run : {};
  const branch = str(run.branch, 120), brief = str(run.prompt, 200).replace(/\s+/g, ' ').trim().slice(0, 90);

  const root = h('div.rv.stack');
  const actions = h('div.row-flex');
  let timer = null, dead = false, sig = '', busyFlag = false, rules = null, loadSeq = 0;
  const written = new Set();                 // rule lines already in REVIEW.md (this visit)

  const reload = () => load(true);
  async function load(force) {
    const mine = ++loadSeq;
    const raw = await api.get('/reviews/' + rid, true);
    if (dead || mine !== loadSeq) return;
    const m = model(raw);
    const busy = IN_PROGRESS.has(m.review.state);
    let accept = null;
    // The server reads the branch HEAD and the tree state itself; the sha sent here is only compared with it.
    if (!busy && m.review.headSha) accept = await api.get(`/reviews/${rid}/can-accept?sha=${m.review.headSha}`, true).catch(() => null);
    if (!busy && (rules === null || force)) rules = await api.get(`/projects/${projectId}/review-rules`, true).catch(() => ({ repeated: [], hasReviewMd: false }));
    if (dead || mine !== loadSeq) return;
    const key = JSON.stringify([m.review.state, m.review.round, m.review.headSha, m.review.approvedSha, m.findings.map((f) => [f.id, f.answer]), m.checks.map((c) => c.ok), m.reasons, accept && accept.ok === true, Array.isArray(rules?.repeated) ? rules.repeated.length : 0]);
    if (force || key !== sig) { sig = key; draw(m, accept); }
    busyFlag = busy;
    if (busy && !dead) schedule(); else clearTimeout(timer);
  }
  const tick = () => { if (!dead) load(false).catch(() => { if (!dead && busyFlag) schedule(); }); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, POLL_MS); };

  // ---- actions ---------------------------------------------------------------------------------------------------------------------
  async function post(path, body, okText) {
    try { const r = await api.post(path, body, true); if (okText) toast(okText, 'ok'); return r; }
    catch (e) { toast(errRu(e), 'err'); return null; }
  }
  const fix = async (b) => {
    b.disabled = true;
    const r = await post(`/reviews/${rid}/fix`, {}, 'Агент продолжил работу в этой же ветке');
    b.disabled = false;
    const id = typeof r?.run?.id === 'string' && /^r[0-9a-z]{2,40}$/.test(r.run.id) ? r.run.id : '';
    if (id) go(`/p/${projectId}/chat/${id}`);
  };
  const approve = async (m, b) => {
    b.disabled = true;
    const r = await post(`/reviews/${rid}/approve`, { sha: m.review.headSha }, 'Коммит подтверждён');
    b.disabled = false;
    if (r) await reload();
  };
  const rerun = async (m, b) => {
    b.disabled = true;
    const r = await post('/reviews', { runId: m.review.runId, effort: m.review.effort });
    b.disabled = false;
    if (r) { sig = ''; await reload(); }
  };
  function answerDialog(f, answer) {
    const rejected = answer === 'rejected';
    const ta = h('textarea.textarea', { rows: 4, maxLength: 1000, placeholder: rejected ? 'Почему это не ошибка' : 'Почему так и задумано', 'aria-label': 'Причина', 'data-autofocus': true });
    const save = async (b) => {
      const reason = ta.value.trim();
      if (!reason) { toast('Напишите причину в одну-две фразы', 'err'); ta.focus(); return; }
      b.disabled = true;
      const r = await post(`/findings/${f.id}/answer`, { answer, reason }, 'Ответ сохранён');
      b.disabled = false;
      if (r) { document.getElementById('dlg').close(); await reload(); }
    };
    const saveBtn = btn('Сохранить', { kind: 'primary', onclick: () => save(saveBtn) });
    dialog(h('div.stack', h('div.bar', h('h2.t-title', rejected ? 'Не баг' : 'Так задумано'), closeBtn()),
      h('p.rv-quote', f.title), h('p.t-meta.mono', `${f.file}${f.line ? ':' + f.line : ''}`),
      field('Причина', ta), h('p.t-meta', 'Причина останется в ревью. Без неё ответ не принимается.'),
      h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), saveBtn)));
  }
  function caseDialog(f) {
    const name = h('input.input', { type: 'text', maxLength: 200, value: f.title, 'aria-label': 'Название примера' });
    const save = async (b) => {
      b.disabled = true;
      const r = await post('/review-eval/cases', { title: name.value.trim() || f.title, diffFrom: 'review', reviewId: rid, findingId: f.id }, 'Пример сохранён в eval/review');
      b.disabled = false;
      if (r) document.getElementById('dlg').close();
    };
    const saveBtn = btn('Сохранить пример', { kind: 'primary', onclick: () => save(saveBtn) });
    dialog(h('div.stack', h('div.bar', h('h2.t-title', 'Пример для проверки ревью'), closeBtn()),
      h('p.rv-quote', f.title), h('p.t-meta.mono', `${f.file}${f.line ? ':' + f.line : ''}`),
      field('Название', name), h('p.t-meta', 'Сохраняются изменения этого файла из ревью и место ошибки. Ключи и пароли в тексте вырезаются. Позже ревью проверят на таких примерах: нашло ли оно эту ошибку.'),
      h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), saveBtn)));
  }
  async function ruleDialog(entry) {
    let r;
    try { r = await api.post(`/projects/${projectId}/review-rules`, { line: entry.line, preview: true }, true); }
    catch (e) { toast(errRu(e), 'err'); if (e && e.status === 409) { written.add(entry.line); await load(true); } return; }
    const ch = Array.isArray(r?.changes) && r.changes[0] && typeof r.changes[0] === 'object' ? r.changes[0] : {};
    const after = str(ch.after, 3000), action = str(ch.action, 20);
    const go2 = btn('Записать в REVIEW.md', { kind: 'primary', onclick: async () => {
      go2.disabled = true;
      const w = await post(`/projects/${projectId}/review-rules`, { line: entry.line, approved: true }, 'Правило записано в REVIEW.md. Отменить можно на вкладке проекта «Инструменты».');
      go2.disabled = false;
      if (w) { written.add(entry.line); document.getElementById('dlg').close(); await load(true); }
    } });
    dialog(h('div.stack', h('div.bar', h('div', h('h2.t-title', 'Вынести в правило'), h('p.t-meta', 'Пока вы не подтвердите, ничего не записано. Перед записью делается копия, откат одной кнопкой.')), closeBtn()),
      h('div.row-flex', chip(action === 'create' ? 'создать файл' : 'изменить файл', action === 'update' ? 'warn' : 'ok'), h('span.mono', 'REVIEW.md')),
      h('b.t-label', 'Добавится строка'), h('pre.rv-pre', '- ' + entry.line),
      after ? h('details', h('summary', 'Как будет выглядеть REVIEW.md целиком'), h('pre.rv-pre', after)) : null,
      h('div.foot', btn('Отмена', { kind: 'glass', onclick: () => document.getElementById('dlg').close() }), go2)), { wide: true });
  }

  // ---- drawing ---------------------------------------------------------------------------------------------------------------------
  function draw(m, accept) {
    const busy = IN_PROGRESS.has(m.review.state);
    const canFix = !busy && blockers(m).length > 0;
    const interrupted = m.reasons.includes('interrupted by a restart');
    actions.replaceChildren(
      !busy && m.review.state !== 'reconsider' ? (() => { const b = btn(interrupted ? 'Запустить ревью снова' : 'Проверить новые коммиты', { kind: interrupted ? 'primary' : 'glass', icon: 'refresh', title: interrupted ? 'Круг ревью прервался при перезапуске хаба: он начнётся заново' : 'Ревью посмотрит только то, что изменилось после прошлого круга', onclick: () => rerun(m, b) }); return b; })() : null);
    const live = m.findings.filter((f) => f.severity !== 'pre-existing');
    const old = m.findings.filter((f) => f.severity === 'pre-existing');
    root.replaceChildren(
      safe(() => summary(m, accept), 'Не удалось показать итог'),
      live.length ? safe(() => findingsBlock(m, live, canFix), 'Не удалось показать находки') : null,
      old.length ? safe(() => oldBlock(m, old), 'Не удалось показать старые проблемы') : null,
      busy ? null : safe(() => rulesBlock(), 'Не удалось показать правила'));
  }

  function headline(m) {
    const st = m.review.state;
    if (IN_PROGRESS.has(st)) return h('div.rv-big', { role: 'status' }, 'Идёт ревью…');
    if (redCheck(m)) return h('div.stack.rv-gap', h('div.rv-big', 'ИИ-ревью не запускалось'), h('p.muted', 'Проверки не прошли: ворота закрыты. Исправьте их и запустите ревью снова, пока ничего не потрачено.'));
    if (st === 'reconsider') return h('div.rv-big', 'Ревью остановлено');
    if (m.reasons.length && !m.findings.length) return h('div.rv-big', 'Ревью не завершилось');
    if (nothingFound(m)) return h('div.stack.rv-gap', h('div.rv-big', 'Нечего исправлять'), h('p.muted', 'Проверяющие ничего не нашли в этих изменениях.'));
    const t = countsText(m), closed = closedCount(m);
    return h('div.stack.rv-gap', h('div.rv-big', t || 'Открытых находок нет'), closed ? h('p.t-meta', `Закрыто ответами или правкой: ${closed}`) : null);
  }

  function summary(m, accept) {
    const r = m.review, [riskT, riskTone] = RISK_RU[r.risk];
    const [stT, stTone] = stateLabel(m);
    const states = stepStates(m);
    const checksBad = m.checks.filter((c) => !c.ok).length;
    return h('section.plane.card.stack.rv-summary', { 'aria-label': 'Итог ревью' },
      h('div.row-flex.rv-meta', branch ? h('span.chip.chip-info', icon('branch', 'sm'), h('span.rv-branch', branch)) : null, chip(stT, stTone), chip(`круг ${r.round} из ${ROUND_CAP}`, 'line'), chip(`глубина: ${pick(EFFORT_RU, r.effort)}`, 'line'), chip(`риск: ${riskT}`, riskTone), r.headSha ? h('span.t-meta.mono', 'коммит ' + short(r.headSha)) : null),
      headline(m),
      r.state === 'reconsider' ? h('div.alert.err', { role: 'alert' }, icon('alert'), h('div.stack', h('b', 'Три круга ревью не сошлись — пересмотрите подход'), h('span', 'Ещё одна заплатка не поможет: вернитесь к задаче и измените план.'))) : null,
      m.reasons.length && r.state !== 'reconsider' && !redCheck(m) ? h('div.alert.warn', icon('alert'), h('ul.rv-list', m.reasons.map((x) => h('li', reasonRu(x))))) : null,
      stepper(states),
      m.checks.length ? checksBlock(m, checksBad) : null,
      m.warnings.length ? h('div.rv-note', icon('info', 'sm'), h('div.stack.rv-gap', m.warnings.map((x) => h('span', warnRu(x))))) : null,
      riskBlock(m),
      acceptLine(m, accept));
  }

  function stepper(states) {
    return h('ol.rv-steps', { 'aria-label': 'Этапы ревью' }, STEPS.map((name, i) => {
      const s = states[i] || 'todo';
      const mark = s === 'done' ? icon('check', 'sm') : s === 'fail' ? icon('alert', 'sm') : s === 'skip' ? '–' : String(i + 1);
      return h('li.rv-step.is-' + s, { 'aria-current': s === 'current' ? 'step' : null }, h('span.rv-mark', mark), h('span.rv-step-t', h('span.rv-step-n', name), h('span.rv-step-s', STEP_TEXT[s])));
    }));
  }

  function checksBlock(m, bad) {
    return h('details.rv-checks', { open: bad > 0 },
      h('summary', bad ? `Проверки: не прошло ${bad} из ${m.checks.length}` : `Проверки: прошли ${m.checks.length} из ${m.checks.length}`),
      h('div.stack.rv-gap', m.checks.map((c) => safe(() => h('div.stack.rv-gap', h('div.row-flex', chip(c.ok ? 'прошла' : 'красная', c.ok ? 'ok' : 'err'), h('span.mono.rv-wrap', c.name)), !c.ok && c.tail ? h('pre.rv-pre', c.tail) : null), 'Проверка не показана'))));
  }

  function riskBlock(m) {
    const r = m.review, [riskT] = RISK_RU[r.risk];
    const why = m.riskWhy.length ? h('details.rv-why', { open: r.risk === 'high' }, h('summary', `Почему риск ${riskT}`), h('ul.rv-list', m.riskWhy.map((x) => h('li', riskWhyRu(x))))) : null;
    const tooLarge = m.humanWhy.length > 0;
    if ((r.risk !== 'high' && !tooLarge) || IN_PROGRESS.has(r.state) || r.state === 'reconsider' || !r.headSha) return why;
    const approved = r.approvedSha && r.approvedSha === r.headSha;
    const b = approved ? null : btn('Подтверждаю этот коммит', { kind: 'primary', icon: 'check', onclick: () => approve(m, b) });
    return h('div.stack.rv-approve', why,
      tooLarge ? h('div.alert.warn', icon('alert'), h('span', reasonRu(m.humanWhy[0]) + '. Посмотрите изменения сами, прежде чем подтверждать.')) : null,
      approved ? h('div.row-flex', chip('вы подтвердили коммит ' + short(r.headSha), 'ok')) : h('p', r.risk === 'high' ? 'Изменения затрагивают опасные места, поэтому нужен ваш взгляд.' : 'Проверяющие видели не всё, поэтому нужен ваш взгляд.'),
      b,
      h('p.t-meta', `Подтверждение привязано к коммиту ${short(r.headSha)}. Любой новый коммит его сбросит, и придётся подтвердить снова.`));
  }

  function acceptLine(m, a) {
    if (IN_PROGRESS.has(m.review.state) || !a || typeof a !== 'object') return null;
    const why = Array.isArray(a.why) ? a.why.map((x) => str(x, 400)).filter(Boolean) : [];
    return h('div.stack.rv-gap.rv-accept',
      a.ok === true ? h('div.row-flex', chip('можно принимать', 'ok')) : h('div.stack.rv-gap', h('div.row-flex', chip('пока нельзя принимать', 'warn')), why.length ? h('ul.rv-list', why.map((x) => h('li', reasonRu(x)))) : null),
      h('p.t-meta', 'Кнопка «Принять результат» появится вместе со слиянием веток. Пока здесь только вердикт ворот.'));
  }

  function findingsBlock(m, list, canFix) {
    const groups = groupByFile(list);
    return h('section.stack.rv-findings', { 'aria-label': 'Находки' },
      h('div.section-head', h('h2.t-heading', 'Находки'), canFix ? (() => { const b = btn(`Исправить агентом: все открытые (${blockers(m).length})`, { kind: 'primary', icon: 'spark', onclick: () => fix(b) }); return b; })() : null),
      canFix ? h('p.t-meta', '«Исправить агентом» отправляет агенту сразу все открытые важные находки: он продолжит в этой же ветке. Потом нажмите «Проверить новые коммиты».') : null,
      groups.map(([file, fs]) => safe(() => h('div.rv-file', h('h3.rv-file-h.mono', file), h('div.stack', fs.map((f) => safe(() => findingCard(m, f), 'Не удалось показать находку')))), 'Не удалось показать файл')));
  }
  function oldBlock(m, list) {
    return h('details.plate.rv-old', h('summary', `Старые проблемы (${list.length}): были до этой задачи, не блокируют`),
      h('div.stack', { style: { marginTop: 'var(--hub-space-3)' } }, groupByFile(list).map(([file, fs]) => safe(() => h('div.rv-file', h('h3.rv-file-h.mono', file), h('div.stack', fs.map((f) => safe(() => findingCard(m, f), 'Не удалось показать находку')))), 'Не удалось показать файл'))));
  }

  function findingCard(m, f) {
    const open = f.answer === 'open', blocking = f.severity === 'important' || f.severity === 'security';
    const votes = votesText(f);
    const answered = !open ? h('div.row-flex', chip(ANSWER_RU[f.answer], f.answer === 'fixed' ? 'ok' : 'line'), f.answer === 'fixed' && f.clearedBy ? h('span.t-meta.mono', 'коммит ' + short(f.clearedBy)) : null, f.reason ? h('span.rv-wrap', f.reason) : null) : null;
    const hunk = f.hunk ? h('pre.rv-hunk', { 'aria-label': 'Код вокруг находки', tabindex: '0' }, f.hunk.lines.map((t, i) => h('span.l' + (i === f.hunk.at ? '.hit' : ''), h('span.n', String(f.hunk.from + i)), t))) : null;
    const ev = f.evidence ? h('details.rv-ev', { open: !f.hunk }, h('summary', 'Что заметил проверяющий'), h('pre.rv-pre', f.evidence)) : null;
    let acts = null;
    const keep = f.id && f.severity !== 'pre-existing' ? btn('Сохранить как пример для проверки ревью', { kind: 'glass', title: 'Изменения этого файла попадут в набор примеров, на которых измеряют качество ревью', onclick: () => caseDialog(f) }) : null;
    if (open && blocking && f.id) {
      const fb = btn('Исправить агентом', { kind: 'glass', icon: 'spark', title: 'Агент получит все открытые важные находки и продолжит в этой же ветке', onclick: () => fix(fb) });
      acts = h('div.row-flex.rv-acts', fb, btn('Не баг — причина…', { kind: 'glass', onclick: () => answerDialog(f, 'rejected') }), btn('Так задумано', { kind: 'glass', onclick: () => answerDialog(f, 'intentional') }), keep);
    } else if (keep) acts = h('div.row-flex.rv-acts', keep);
    return h('article.plate.rv-finding' + (open ? '' : '.is-closed'), { 'data-severity': f.severity },
      h('div.row-flex.rv-fh', chipOf(SEV_RU, f.severity), f.classOfBug ? chip('класс ошибки: ' + f.classOfBug, 'line') : null, h('span.t-meta.mono', `строка ${f.line || '?'}`)),
      h('h4.rv-title', f.title), hunk, ev,
      votes ? h('p.t-meta', votes) : null, answered, acts);
  }

  function rulesBlock() {
    const rep = Array.isArray(rules?.repeated) ? rules.repeated.slice(0, 3).map((r0) => ({ cls: str(r0?.classOfBug, 160), count: Math.max(0, Math.trunc(Number(r0?.count) || 0)), line: str(r0?.line, 400) })).filter((r) => r.cls && r.line) : [];
    if (!rep.length) return null;
    return h('section.plane.card.stack', { 'aria-label': 'Повторяющиеся ошибки' },
      h('h2.t-heading', 'Повторяется — вынести в правило'),
      h('p.muted', 'Одна и та же ошибка находится снова и снова. Если записать её в REVIEW.md, проверяющие и агенты будут знать о ней заранее.'),
      rep.map((r) => safe(() => h('div.stack.rv-gap.rv-rule', h('div.row-flex', chip(`встречалось ${r.count} ${plural(r.count, ['раз', 'раза', 'раз'])}`, 'warn'), h('b.rv-wrap', r.cls)),
        h('p.rv-quote', r.line),
        written.has(r.line) ? h('div.row-flex', chip('записано в REVIEW.md', 'ok')) : rules.hasReviewMd === false ? h('p.t-meta', 'В проекте нет REVIEW.md: сначала подготовьте проект.') : btn('Вынести в правило…', { kind: 'glass', icon: 'file', onclick: () => ruleDialog(r) })), 'Правило не показано')));
  }

  root.append(h('div.skeleton', { style: { height: '120px' } }));
  await load(true);
  return {
    title: 'Ревью',
    cleanup: () => { dead = true; clearTimeout(timer); },
    node: h('div', pageHead({ crumbs: [{ text: 'Проекты', href: '/projects' }, { text: slug, href: `/p/${projectId}/tasks` }, { text: 'Ревью' }], title: 'Ревью', sub: brief ? h('span.rv-wrap', brief) : null, actions }), root),
  };
}

// ---- the card under a finished task run, and the task list --------------------------------------------------------------------------

/** Latest review of a thread, or null. `runs` newest last. The server answers with the reviews of the run's whole branch, so any run finds it. */
export async function threadReview(runs) {
  const ids = runs.filter((r) => typeof r.id === 'string' && r.branch).map((r) => r.id).reverse().slice(0, 8);
  const lists = await Promise.all(ids.map((id) => api.get(`/runs/${id}/reviews`, true).catch(() => [])));
  for (const l of lists) if (Array.isArray(l) && l.length) { const last = l[l.length - 1]; if (last && typeof last.id === 'string' && /^rv[0-9a-z]{2,40}$/.test(last.id)) return last; }
  return null;
}

/** Chat card: «Ревью: N важных, M мелочей» with a link, or the effort picker and «Запустить ревью». */
export async function reviewCard({ runs, projectId }) {
  const last = runs[runs.length - 1];
  const rv = await threadReview(runs);
  if (rv) {
    const m = model(await api.get('/reviews/' + rv.id, true));
    const busy = IN_PROGRESS.has(m.review.state), [stT, stTone] = stateLabel(m);
    const pid = m.review.projectId || projectId;
    const again = busy ? null : (() => { const b = btn('Проверить новые коммиты', { kind: 'glass', icon: 'refresh', onclick: async () => { b.disabled = true; try { await api.post('/reviews', { runId: m.review.runId, effort: m.review.effort }, true); go(`/p/${pid}/review/${m.review.id}`); } catch (e) { toast(errRu(e), 'err'); b.disabled = false; } } }); return b; })();
    return h('section.plate.rv-card.stack', { 'aria-label': 'Ревью задачи' },
      h('div.row-flex', h('b.t-heading', cardText(m)), chip(stT, stTone)),
      h('div.row-flex', h('a.btn.btn-primary', { href: `#/p/${pid}/review/${m.review.id}` }, 'Открыть ревью'), again));
  }
  let effort = 'standard';
  const box = h('div.rv-efforts', { role: 'group', 'aria-label': 'Глубина ревью' });
  const drawEfforts = () => box.replaceChildren(...EFFORTS.map((e) => h('button.rv-effort', { type: 'button', 'aria-pressed': String(effort === e.id), onclick: () => { effort = e.id; drawEfforts(); } },
    h('span.rv-effort-n', e.name), h('span.t-meta', `ищут: ${e.hunters} · подтверждают: ${e.verifiers}`), h('span.rv-effort-t', e.text))));
  drawEfforts();
  const go1 = btn('Запустить ревью', { kind: 'primary', icon: 'check', onclick: async () => {
    go1.disabled = true;
    try { const r = await api.post('/reviews', { runId: last.id, effort }, true); const id = typeof r?.id === 'string' && /^rv[0-9a-z]{2,40}$/.test(r.id) ? r.id : ''; if (id) go(`/p/${projectId}/review/${id}`); else go1.disabled = false; }
    catch (e) { toast(errRu(e), 'err'); go1.disabled = false; }
  } });
  return h('section.plate.rv-card.stack', { 'aria-label': 'Ревью задачи' },
    h('b.t-heading', 'Задача готова: проверьте её перед приёмом'),
    h('p.muted', 'Ревью ищет ошибки в том, что сделал агент. Отдельно всегда идёт проверка безопасности. Пока ревью не пройдено, результат принять нельзя.'),
    box, h('div.row-flex', go1));
}

/** Task list: runs that are "На ревью" get a link to their review (or to the chat where the review can be started). Never throws. */
export async function reviewLinks(runs) {
  const out = new Map();                                  // run id -> { review } | { start: true }
  try {
    const byCwd = new Map();
    for (const r of runs) if (r.outcome === 'review' && typeof r.cwd === 'string') { if (!byCwd.has(r.cwd)) byCwd.set(r.cwd, []); byCwd.get(r.cwd).push(r); }
    await Promise.all([...byCwd.entries()].slice(0, 30).map(async ([, group]) => {
      const sorted = group.slice().sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
      const rv = await threadReview(sorted).catch(() => null);
      const newest = sorted[sorted.length - 1];
      if (newest) out.set(newest.id, rv ? { review: rv } : { start: true });
    }));
  } catch { /* the list still works without links */ }
  return out;
}
export function reviewLink(projectId, run, info) {
  if (!info) return null;
  if (info.review) { const st = pick(STATE_RU, info.review.state) ?? ['ревью', 'line']; return h('a.btn.btn-glass.rv-task-link', { href: `#/p/${projectId}/review/${info.review.id}` }, icon('check', 'sm'), `Ревью: ${st[0].toLowerCase()}`); }
  return h('a.btn.btn-glass.rv-task-link', { href: `#/p/${projectId}/chat/${run.id}` }, icon('check', 'sm'), 'Запустить ревью');
}
