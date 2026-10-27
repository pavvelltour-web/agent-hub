// The data layer of the project forecast block (Phase 7.3). Plain JS, no DOM: the hostile-data rules are tested in node (src/econ/forecast.test.ts).
// The answer of `GET /api/projects/:id/forecast` is read by type (never `String(x)`): a range with a non-number is dropped, a label outside the known set
// becomes «оценка», text is stripped of control, bidi and zero-width characters. Every number is shown with the label the server gave it.
const LABELS = new Set(['measured', 'estimated', 'unknown']);
const BASES = new Set(['measured', 'mixed', 'estimated']);
const AGENTS = ['claude', 'codex'];
const AGENT_RU = { claude: 'Claude', codex: 'Codex' };

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const whole = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
const INVISIBLE = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const plain = (s, n) => (typeof s === 'string' ? s.slice(0, n).replace(INVISIBLE, '') : '');
const range = (r) => {
  const x = obj(r);
  if (typeof x.p50 !== 'number' || typeof x.p90 !== 'number' || !Number.isFinite(x.p50) || !Number.isFinite(x.p90) || x.p50 < 0 || x.p90 < x.p50) return null;
  return { p50: x.p50, p90: x.p90, label: LABELS.has(x.label) ? x.label : 'estimated' };
};

/** The server's answer, typed. `null` when it is not an object. */
export function forecastModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = obj(raw), t = obj(r.tasks), f = obj(r.forecast);
  const limit = {};
  for (const a of AGENTS) { const x = range(obj(f.limitPct)[a]); if (x) limit[a] = x; }
  return {
    enough: r.enough === true, reason: plain(r.reason, 80),
    open: whole(t.open), done: whole(t.done), total: whole(t.total), guessed: whole(t.guessed), truncated: t.truncated === true,
    files: (Array.isArray(t.files) ? t.files : []).filter((x) => typeof x === 'string').slice(0, 10).map((x) => plain(x, 120)),
    basis: BASES.has(f.basis) ? f.basis : 'estimated', limit, weeks: range(f.weeks), usd: range(f.usd), sampleRuns: whole(r.sampleRuns),
    risk: (Array.isArray(f.risk) ? f.risk : []).filter((x) => typeof x === 'string').slice(0, 8).map((x) => plain(x, 220)).filter(Boolean),
    classes: (Array.isArray(f.classes) ? f.classes : []).slice(0, 7).map((c) => ({ cls: plain(obj(c).cls, 20), tasks: whole(obj(c).tasks), n: whole(obj(c).n), label: LABELS.has(obj(c).label) ? obj(c).label : 'estimated' })),
  };
}

const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const num1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');
export const pctRange = (r) => { const a = Math.round(r.p50), b = Math.round(r.p90); return a === b ? `${a} %` : `${a}–${b} %`; };
export function weeksText(r) {
  if (r.p90 === 0) return 'уложится в текущий период лимита';
  const a = r.p50 < 10 ? num1(r.p50) : String(Math.round(r.p50)), b = r.p90 < 10 ? num1(r.p90) : String(Math.round(r.p90));
  const frac = !Number.isInteger(r.p90) && r.p90 < 10;   // «0,7 недели»: a fraction takes the genitive singular
  return `${a === b ? a : `${a}–${b}`} ${frac ? 'недели' : plural(Math.round(r.p90), 'неделя', 'недели', 'недель')} по лимитам`;
}
export const usdText = (r) => `≈ $${Math.round(r.p50)}–${Math.round(r.p90)} по ценам API`;
/** Where the numbers come from, in plain words. */
export function basisText(m) {
  const n = m.sampleRuns;
  if (m.basis === 'measured') return `основа: ваши данные (${n} ${plural(n, 'запуск', 'запуска', 'запусков')})`;
  if (m.basis === 'mixed') return `основа: ваши данные (${n} ${plural(n, 'запуск', 'запуска', 'запусков')}) и оценки`;
  return 'основа: пока только оценки';
}

/** «Осталось 14 задач · ≈ 35–60 % недели Claude и 10–20 % Codex · 1–2 недели по лимитам · основа: ваши данные (9 запусков) и оценки». */
export function forecastLine(m) {
  if (!m.enough) return m.reason || 'недостаточно данных';
  const parts = [`Осталось ${m.open} ${plural(m.open, 'задача', 'задачи', 'задач')}`];
  const lim = AGENTS.filter((a) => m.limit[a]).map((a, i) => `${pctRange(m.limit[a])} ${i === 0 ? 'недели ' : ''}${AGENT_RU[a]}`);
  if (m.open === 0) parts.push('считать нечего');
  else {
    if (lim.length) parts.push('≈ ' + lim.join(' и '));
    if (m.weeks) parts.push(weeksText(m.weeks));
    if (m.usd) parts.push(usdText(m.usd));
    parts.push(basisText(m));
  }
  return parts.join(' · ');
}
