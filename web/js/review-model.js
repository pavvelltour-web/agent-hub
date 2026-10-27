// Review screen model: turns the untrusted JSON of GET /api/reviews/:id into plain, typed values and Russian words. No DOM here (unit-tested in node).
// Everything the model or a repository wrote (titles, files, evidence, reasons) is read by type: an object where a string is expected becomes '' (never String(x)).

export const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/\u0000/g, '').slice(0, max) : '');
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Lookup in a fixed table by a key from data: own string keys only, so an object key cannot throw or reach the prototype. */
export const pick = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
const arr = (v, max = 200) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v) ? v.toLowerCase() : '');
const idOf = (v, re) => (typeof v === 'string' && re.test(v) ? v : '');
export const short = (s) => String(s || '').slice(0, 10);

export const plural = (n, [one, few, many]) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

export const ROUND_CAP = 3;
export const IN_PROGRESS = new Set(['checks', 'hunting', 'verifying']);
export const STATE_RU = { checks: ['Идут проверки', 'info'], hunting: ['Идёт поиск ошибок', 'info'], verifying: ['Проверяем находки', 'info'], open: ['Есть замечания', 'warn'], passed: ['Пройдено', 'ok'], 'needs-human': ['Ждёт вашего подтверждения', 'warn'], reconsider: ['Пересмотрите подход', 'err'] };
export const RISK_RU = { low: ['низкий', 'ok'], medium: ['средний', 'warn'], high: ['высокий', 'err'] };
export const SEV_RU = { security: ['Безопасность', 'err'], important: ['Важное', 'warn'], nit: ['Мелочь', 'line'], 'pre-existing': ['Старое', 'info'] };
export const ANSWER_RU = { open: 'Открыто', fixed: 'Исправлено', rejected: 'Не баг', intentional: 'Так задумано', dismissed: 'Снято' };
export const EFFORTS = [
  { id: 'quick', name: 'Быстро', hunters: 1, verifiers: 1, text: 'Один проверяющий ищет ошибки, один подтверждает. Для рутины и текстов.' },
  { id: 'standard', name: 'Стандартно', hunters: 3, verifiers: 2, text: 'Трое смотрят с разных сторон, каждую находку подтверждают двое. Обычный выбор.' },
  { id: 'deep', name: 'Глубоко', hunters: 5, verifiers: 3, text: 'Пятеро ищут, каждую находку подтверждают трое. Для входа, ключей, денег, удаления, установщиков, CI и миграций.' },
];
export const EFFORT_RU = { quick: 'быстро', standard: 'стандартно', deep: 'глубоко' };

const FD = /^fd[0-9a-z]{2,40}$/, RV = /^rv[0-9a-z]{2,40}$/, RN = /^r[0-9a-z]{2,40}$/;

function hunkOf(raw) {
  const k = obj(raw), lines = arr(k.lines, 9).map((l) => str(l, 300));
  if (!lines.length) return null;
  const from = Math.max(1, Math.trunc(num(k.from)) || 1);
  return { from, at: Math.min(lines.length - 1, Math.max(0, Math.trunc(num(k.at)))), lines };
}

/** The whole GET /api/reviews/:id answer as safe values. Never throws. */
export function model(raw) {
  const r = obj(raw), rv = obj(r.review);
  const review = {
    id: idOf(rv.id, RV), runId: idOf(rv.runId, RN), projectId: Math.max(0, Math.trunc(num(rv.projectId))),
    headSha: sha(rv.headSha), baseSha: sha(rv.baseSha),
    effort: pick(EFFORT_RU, rv.effort) ? rv.effort : 'standard', risk: pick(RISK_RU, rv.risk) ? rv.risk : 'low',
    round: Math.max(1, Math.trunc(num(rv.round)) || 1), state: pick(STATE_RU, rv.state) ? rv.state : 'open', approvedSha: sha(obj(rv.humanApproval).sha),
  };
  const findings = arr(r.findings, 300).filter((f0) => f0 && typeof f0 === 'object' && !Array.isArray(f0)).map((f0) => {
    const f = obj(f0), v = obj(f.votes);
    return {
      id: idOf(f.id, FD), severity: pick(SEV_RU, f.severity) ? f.severity : 'nit',
      file: str(f.file, 300).trim() || '(файл не указан)', line: Math.max(0, Math.trunc(num(f.line))),
      title: str(f.title, 300).trim() || 'Без названия', evidence: str(f.evidence, 1500), classOfBug: str(f.classOfBug, 160).trim(),
      votes: { real: Math.max(0, Math.trunc(num(v.real))), notReal: Math.max(0, Math.trunc(num(v.notReal))) },
      answer: pick(ANSWER_RU, f.answer) ? f.answer : 'open', reason: str(f.reason, 600), clearedBy: sha(f.clearedBy), hunk: hunkOf(f.hunk),
    };
  });
  const checks = arr(r.checks, 30).filter((c0) => c0 && typeof c0 === 'object' && !Array.isArray(c0)).map((c0) => { const c = obj(c0); return { name: str(c.name, 160) || '(проверка без имени)', ok: c.ok === true, tail: str(c.tail, 4000) }; });
  const lines = (v) => arr(v, 30).map((x) => str(x, 400).trim()).filter(Boolean);
  return { review, findings, checks, warnings: lines(r.warnings), reasons: lines(r.reasons), riskWhy: lines(r.riskWhy), humanWhy: lines(r.humanWhy) };
}

// ---- counts ----------------------------------------------------------------------------------------------------------------------------

const isOpen = (f) => f.answer === 'open';
export const blockers = (m) => m.findings.filter((f) => isOpen(f) && (f.severity === 'important' || f.severity === 'security'));
const count = (m, sev) => m.findings.filter((f) => f.severity === sev && (sev === 'pre-existing' || isOpen(f))).length;

/** "1 по безопасности, 2 важных, 1 мелочь, 3 старых проблемы"; '' when nothing is left. Closed findings are not counted. */
export function countsText(m) {
  const sec = count(m, 'security'), imp = count(m, 'important'), nit = count(m, 'nit'), old = count(m, 'pre-existing');
  return [
    sec ? `${sec} по безопасности` : '',
    imp ? `${imp} ${imp === 1 ? 'важная' : 'важных'}` : '',
    nit ? `${nit} ${plural(nit, ['мелочь', 'мелочи', 'мелочей'])}` : '',
    old ? `${old} ${plural(old, ['старая проблема', 'старые проблемы', 'старых проблем'])}` : '',
  ].filter(Boolean).join(', ');
}
export const closedCount = (m) => m.findings.filter((f) => f.severity !== 'pre-existing' && !isOpen(f)).length;

/** The short line of the chat card: «Ревью: 2 важных, 1 мелочь». */
export function cardText(m) {
  const st = m.review.state;
  if (IN_PROGRESS.has(st)) return 'Ревью идёт…';
  if (m.checks.some((c) => !c.ok)) return 'Ревью: проверки не прошли, ИИ-ревью не запускалось';
  if (st === 'reconsider') return 'Ревью: три круга не сошлись, пересмотрите подход';
  if (m.reasons.length && !m.findings.length) return 'Ревью не завершилось';
  const imp = blockers(m).length, nit = count(m, 'nit');
  return `Ревью: ${imp} ${imp === 1 ? 'важная' : 'важных'}, ${nit} ${plural(nit, ['мелочь', 'мелочи', 'мелочей'])}`;
}

/** Why the AI review did not run / finish (for the headline). */
export const redCheck = (m) => m.checks.some((c) => !c.ok);
export const nothingFound = (m) => !IN_PROGRESS.has(m.review.state) && !redCheck(m) && !m.reasons.length && m.review.state !== 'reconsider' && m.findings.length === 0;

/** Stepper: Проверки → Поиск → Проверка находок → Безопасность → Ответы. One of done | current | todo | fail | skip per step. */
export function stepStates(m) {
  const s = m.review.state;
  if (redCheck(m)) return ['fail', 'skip', 'skip', 'skip', 'skip'];
  if (s === 'checks') return ['current', 'todo', 'todo', 'todo', 'todo'];
  if (s === 'hunting') return ['done', 'current', 'todo', 'todo', 'todo'];
  if (s === 'verifying') return ['done', 'done', 'current', 'todo', 'todo'];
  if (m.reasons.length && s !== 'reconsider') return [m.checks.length ? 'done' : 'skip', 'skip', 'skip', 'skip', 'skip'];
  const sec = m.findings.some((f) => f.severity === 'security' && isOpen(f));
  return ['done', 'done', 'done', sec ? 'fail' : 'done', blockers(m).length ? 'current' : 'done'];
}
export const STEPS = ['Проверки', 'Поиск', 'Проверка находок', 'Безопасность', 'Ответы'];
export const STEP_TEXT = { done: 'готово', current: 'сейчас', todo: 'ждёт', fail: 'не прошло', skip: 'не запускалось' };

export function groupByFile(findings) {
  const g = new Map();
  for (const f of findings) { if (!g.has(f.file)) g.set(f.file, []); g.get(f.file).push(f); }
  return [...g];
}

export function votesText(f) {
  const total = f.votes.real + f.votes.notReal;
  if (!total) return '';
  return total === 1 ? `${f.votes.real} из 1 проверяющего согласен` : `${f.votes.real} из ${total} ${plural(total, ['проверяющего', 'проверяющих', 'проверяющих'])} согласны`;
}

// ---- Russian words for the server's English reasons ---------------------------------------------------------------------------

const ROLE = (a) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : a);
/** Reasons from canAccept / the gate. Unknown text is kept as it is (it is data, shown as text). */
export function reasonRu(t) {
  const s = str(t, 400);
  let m;
  if ((m = /^no review yet for commit (\w+): the last review covers (\w+)$/.exec(s))) return `Для коммита ${m[1]} ревью ещё нет: последнее было для ${m[2]}`;
  if (s === 'no review yet') return 'Ревью ещё не было';
  if (/^the review is still running/.test(s)) return 'Ревью ещё идёт';
  if ((m = /^(\d+) open security findings?$/.exec(s))) return `Открытых проблем безопасности: ${m[1]}`;
  if ((m = /^(\d+) open important findings?$/.exec(s))) return `Открытых важных находок: ${m[1]}`;
  if ((m = /^high-risk change: a human must approve commit (\w+)/.exec(s))) return `Высокий риск: нужно ваше подтверждение коммита ${m[1]}`;
  if (s === 'the review is open') return 'Ревью не закрыто';
  if ((m = /^checks failed: (.*)$/.exec(s))) return `Проверки не прошли: ${m[1]}`;
  if (/^no usable reviewer/.test(s)) return 'Нет доступного проверяющего: войдите в Claude или Codex';
  if (/^nothing to review/.test(s)) return 'Нечего проверять: изменений нет';
  if (/^cannot read the diff/.test(s)) return 'Не удалось прочитать изменения';
  if ((m = /^reviewer failed: (.*)$/.exec(s))) return `Проверяющий не справился: ${m[1]}`;
  if ((m = /^review stopped: (.*)$/.exec(s))) return `Ревью остановилось: ${m[1]}`;
  if (s === 'interrupted by a restart') return 'Ревью прервано перезапуском хаба: запустите его снова';
  if ((m = /^too many findings to verify: (\d+) of (\d+)/.exec(s))) return `Слишком много находок: ${m[1]} из ${m[2]} не проверены. Запустите ревью снова, чтобы проверить остальные`;
  if ((m = /^diff too large to review fully: a human must approve commit (\w+)/.exec(s))) return `Изменения слишком большие, проверяющие видели только начало: нужно ваше подтверждение коммита ${m[1]}`;
  if (s === 'diff too large to review fully') return 'Изменения слишком большие, проверяющие видели только начало';
  if (/^the task folder has uncommitted changes/.test(s)) return 'В папке задачи есть незакоммиченные изменения: их никто не проверял';
  if (s === 'the task folder is gone') return 'Папки задачи больше нет';
  if (/^cannot read the (branch head|state of the task folder)/.test(s)) return 'Не удалось прочитать состояние ветки';
  if ((m = /^the screen shows commit (\w+), but the branch is at (\w+)/.exec(s))) return `На экране коммит ${m[1]}, а ветка уже на ${m[2]}: обновите страницу`;
  return s;
}
export function warnRu(t) {
  const s = str(t, 400);
  let m;
  if ((m = /^only (\w+) is usable/.exec(s))) return `Работает только ${ROLE(m[1])}: все проверяющие от одного поставщика, взгляд с разных сторон слабее`;
  if (/^claude is not usable/.test(s)) return 'Claude недоступен: находки подтверждает Codex';
  if ((m = /^(claude|codex): not installed/.exec(s))) return `${ROLE(m[1])} не установлен`;
  if ((m = /^(claude|codex): not signed in/.exec(s))) return `${ROLE(m[1])}: нужен вход`;
  if (/^codex: signed in with a ChatGPT/.test(s)) return 'Codex: вход через аккаунт ChatGPT не подходит для gpt-6.1-sol, Codex не используется';
  return s;
}
const RISK_LABEL = {
  'CI / pipeline file': 'Файлы CI и сборки', 'agent rules or configuration': 'Правила и настройки агентов', 'dependency manifest': 'Список зависимостей', lockfile: 'Файл версий зависимостей',
  'git hook': 'Git-хук', 'authentication, keys or secrets': 'Вход, ключи или секреты', 'payments or billing': 'Платежи', deletion: 'Удаление', installer: 'Установщик', hooks: 'Хуки', migration: 'Миграции',
  'owner-listed path (humanPaths)': 'Путь из списка «нужен человек»', 'path outside the project or malformed': 'Путь вне проекта или повреждён',
  'source changes with no high-risk path': 'Изменён код, опасных путей нет', 'only docs, copy or images changed': 'Изменены только тексты и картинки', 'no changed paths': 'Изменённых файлов нет', 'changed paths unreadable': 'Список изменённых файлов не прочитан',
};
export function riskWhyRu(t) {
  const s = str(t, 400), i = s.indexOf(': ');
  const label = i < 0 ? s : s.slice(0, i), rest = i < 0 ? '' : s.slice(i + 2).replace(/\(\+(\d+) more\)/, '(ещё $1)');
  const ru = pick(RISK_LABEL, label) ?? label;
  return rest ? `${ru}: ${rest}` : ru;
}
/** Server error text for a toast. */
export function errRu(e) {
  const s = str(e && typeof e === 'object' ? e.message : '', 300);
  if (/nothing to fix/.test(s)) return 'Нечего исправлять: открытых важных находок нет';
  if (/still running/.test(s)) return 'Ревью ещё идёт';
  if (/still working in this branch/.test(s)) return 'Агент ещё работает в этой ветке';
  if (/only an open finding/.test(s)) return 'Эта находка уже закрыта';
  if (/'dismissed' needs a reason/.test(s)) return 'Чтобы снять важную находку, напишите причину';
  if (/no session id/.test(s)) return 'Нечего продолжать: у задачи нет сохранённого разговора';
  if (/read-only/.test(s)) return 'Эта ветка открыта только для чтения: разрешите правки в чате';
  if (/only task runs/.test(s)) return 'Исправлять и проверять можно только задачи в своей ветке';
  if (/not the commit that was reviewed/.test(s)) return 'Это уже не тот коммит: запустите следующий круг ревью';
  if (/already in REVIEW\.md/.test(s)) return 'Такая строка уже есть в REVIEW.md';
  if (/REVIEW\.md not found/.test(s)) return 'В проекте нет REVIEW.md: сначала подготовьте проект';
  if (/run is still running/.test(s)) return 'Агент ещё работает над задачей';
  return s || 'Не получилось';
}
