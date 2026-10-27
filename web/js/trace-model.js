// The data layer of the run trace page. Plain JS, no DOM: the hostile-data rules are tested in node (src/run/trace-model.test.ts).
// Everything from the server is read by type and never stringified (`String(x)` on `{toString: 1}` throws); names are shown with invisible,
// bidi and control characters turned into visible escapes so a tool name cannot hide its real text. The page draws all of it with textContent (ADR-012).
const OUTCOMES = new Set(['done', 'review', 'failed', 'limit', 'stopped', 'guard', 'context', 'interrupted']);
const AGENTS = new Set(['claude', 'codex']);
const RUN_ID = /^r[0-9a-z]{2,40}$/;
const MAX_TURNS = 200, MAX_TOOLS = 100, MAX_SLOW = 10;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const int = (v) => Math.floor(num(v));
const INVISIBLE = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]]
  .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');
/** A string from the server: capped, and every control / invisible / bidi character written out as \uXXXX. Anything that is not a string is ''. */
export const plain = (s, n = 100) => (typeof s === 'string' ? s.slice(0, n).replace(INVISIBLE, (c) => '\\' + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : '');

/** Duration in plain Russian: «290 мс», «1,5 с», «2 мин 5 с». */
export function msText(v) {
  const ms = num(v);
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace('.', ',')} с`;
  return `${Math.floor(ms / 60000)} мин ${Math.round((ms % 60000) / 1000)} с`;
}

const tokens = (v) => { const t = obj(v); return { newIn: int(t.newIn), cachedIn: int(t.cachedIn), out: int(t.out), reasoning: int(t.reasoning) }; };
const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** The server's answer for `GET /api/runs/:id/trace`, typed. `null` when it is not a trace at all. */
export function traceModel(raw) {
  const r = obj(raw);
  if (!Array.isArray(r.turns)) return null;
  const run = obj(r.run);
  const turns = r.turns.filter((t) => t && typeof t === 'object' && !Array.isArray(t)).slice(0, MAX_TURNS).map((t, i) => {
    const d = obj(t), tk = tokens(d.tokens), at = typeof d.startedAt === 'string' && Number.isFinite(Date.parse(d.startedAt)) ? d.startedAt : '';
    return {
      n: Number.isInteger(d.n) && d.n > 0 ? d.n : i + 1, startedAt: at, ms: num(d.ms), model: plain(d.model), tokens: tk, context: int(d.context),
      cacheHit: Math.min(1, num(d.cacheHit)), costUsd: money(d.costUsd), toolsMore: int(d.toolsMore),
      tools: (Array.isArray(d.tools) ? d.tools : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, MAX_TOOLS).map((x) => ({ name: plain(x.name) || 'unknown', ms: num(x.ms), ok: x.ok === true, bytes: int(x.bytes), open: x.open === true })),
    };
  });
  const tot = obj(r.totals);
  return {
    run: { id: typeof run.id === 'string' && RUN_ID.test(run.id) ? run.id : '', agent: AGENTS.has(run.agent) ? run.agent : '', model: plain(run.model), effort: plain(run.effort, 20), outcome: OUTCOMES.has(run.outcome) ? run.outcome : '' },
    turns, total: int(r.total), next: Number.isInteger(r.next) && r.next > 0 ? r.next : null, truncated: r.truncated === true,
    totals: { ...tokens(tot), ms: num(tot.ms), costUsd: money(tot.costUsd) },
    slowest: (Array.isArray(r.slowest) ? r.slowest : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, MAX_SLOW).map((x) => ({ name: plain(x.name) || 'unknown', ms: num(x.ms), turn: int(x.turn) })),
  };
}

/**
 * Timeline segments: one per turn, wide by its time (a turn with no measured time still gets a sliver, so nothing disappears). Inside, the tool
 * calls and the rest (the model's own time). Parallel tools can add up to more than the turn: they are scaled down to fit.
 */
export function lanes(turns) {
  const total = turns.reduce((a, t) => a + t.ms, 0), floor = total > 0 ? total * 0.01 : 1;
  return turns.map((t) => {
    const tools = t.tools.filter((x) => x.ms > 0), sum = tools.reduce((a, x) => a + x.ms, 0), k = sum > t.ms && sum > 0 ? t.ms / sum : 1;
    const parts = tools.map((x) => ({ kind: 'tool', name: x.name, ok: x.ok, flex: x.ms * k }));
    const rest = t.ms - Math.min(sum, t.ms);
    if (rest > 0) parts.push({ kind: 'rest', name: '', ok: true, flex: rest });
    return { n: t.n, flex: Math.max(t.ms, floor), ms: t.ms, parts };
  });
}

/** Append the next page to what is shown: turns by number (a repeated page adds nothing), everything else from the newest answer. */
export function mergePage(have, next) {
  const last = have.turns.at(-1)?.n ?? 0;
  return { ...next, turns: [...have.turns, ...next.turns.filter((t) => t.n > last)] };
}
