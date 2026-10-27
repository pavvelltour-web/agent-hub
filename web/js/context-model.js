// The data layer of the context gauge in the chat header. Plain JS, no DOM: the hostile-data rules are tested in node (src/econ/context.test.ts).
// The answer of `GET /api/runs/:id/context` is read by type (never `String(x)`); the numbers are the per-call prompt sizes of ADR-018, the window is
// null unless the price table names one (then the gauge shows «окно неизвестно» and no bar), and rules/skills are estimates and are written as such.
const LEVELS = new Set(['ok', 'amber', 'red']);
const AGENTS = new Set(['claude', 'codex']);
const RUN_ID = /^r[0-9a-z]{2,40}$/;
const WARM_SEC = 120;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const orNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const INVISIBLE = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
const plain = (s, n) => (typeof s === 'string' ? s.slice(0, n).replace(INVISIBLE, '') : '');

/** Tokens in plain Russian: «900», «64 тыс», «1 млн», «1,5 млн». */
export function tokText(v) {
  const n = num(v);
  if (n >= 1e6) return `${(Math.round(n / 1e5) / 10).toString().replace('.', ',')} млн`;
  if (n >= 1000) return `${Math.round(n / 1000)} тыс`;
  return String(Math.round(n));
}

/** The server's answer, typed. `null` when it is not an object at all. */
export function contextModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = obj(raw), b = obj(r.breakdown), c = obj(r.cache);
  const ttl = num(c.ttlSec), age = orNull(c.ageSec);
  return {
    runId: typeof r.runId === 'string' && RUN_ID.test(r.runId) ? r.runId : '', agent: AGENTS.has(r.agent) ? r.agent : '', model: plain(r.model, 100), live: r.live === true,
    turns: Math.floor(num(r.turns)), used: orNull(r.used), window: num(r.window) > 0 ? num(r.window) : null, level: LEVELS.has(r.level) ? r.level : 'ok',
    handoffAt: num(r.handoffAt) || 250000, amberAt: num(r.amberAt) || 200000, rulesTokens: num(r.rulesTokens), skillsTokens: num(r.skillsTokens),
    cache: age !== null && ttl > 0 ? { ageSec: age, ttlSec: ttl } : null,
    breakdown: r.breakdown && typeof r.breakdown === 'object' ? { system: num(b.system), rules: num(b.rules), skills: num(b.skills), conversation: num(b.conversation), turnsLeft: orNull(b.turnsLeft) } : null,
  };
}

const steps = (n) => { const a = n % 10, b = n % 100; return `${n} ${a === 1 && b !== 11 ? 'шаг' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'шага' : 'шагов'}`; };

/** The line of the gauge as separate pieces: «Контекст 64 тыс из 1 млн · правила ≈ 2 тыс · скиллы ≈ 18 тыс · разговор 30 тыс · до передачи ≈ 12 шагов». */
export function gaugeText(m) {
  if (m.used === null) return ['Контекст ещё не измерен'];
  const out = [m.window ? `Контекст ${tokText(m.used)} из ${tokText(m.window)}` : `Контекст ${tokText(m.used)}`];
  if (!m.window) out.push('окно неизвестно');
  const b = m.breakdown;
  if (b) {
    if (b.system > 0) out.push(`система ${tokText(b.system)}`);
    if (b.rules > 0) out.push(`правила ≈ ${tokText(b.rules)}`);
    if (b.skills > 0) out.push(`скиллы ≈ ${tokText(b.skills)}`);
    if (b.conversation > 0) out.push(`разговор ${tokText(b.conversation)}`);
    if (b.turnsLeft === 0) out.push(m.level === 'red' ? 'до передачи: пора' : 'до передачи меньше шага');
    else if (b.turnsLeft !== null) out.push(`до передачи ≈ ${steps(b.turnsLeft)}`);
  }
  return out;
}

/** Bar segments as a percentage of the WINDOW. No window, no bar: an empty list. */
export function segments(m) {
  if (!m.window || !m.breakdown) return [];
  return ['system', 'rules', 'skills', 'conversation'].filter((k) => m.breakdown[k] > 0).map((kind) => ({ kind, pct: Math.min(100, (m.breakdown[kind] / m.window) * 100) }));
}

/** The pause warning for Claude (the 5-minute cache is Anthropic's rule): nothing while the agent works or the cache is warm. `elapsedSec` = time since the answer arrived. */
export function cacheLine(m, elapsedSec) {
  if (!m.cache || m.live || m.agent !== 'claude') return null;
  const age = m.cache.ageSec + num(elapsedSec);
  if (age <= WARM_SEC) return null;
  if (age >= m.cache.ttlSec) return { text: 'Кэш остыл: следующее сообщение дороже', tone: 'warn' };
  return { text: `Кэш остынет через ${Math.ceil((m.cache.ttlSec - age) / 60)} мин`, tone: 'warn' };
}
