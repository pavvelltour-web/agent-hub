import { costUsd, type Tokens } from '../econ/econ.ts';
import type { Db } from '../history/store.ts';
import { redact } from '../lib/redact.ts';
import type { StoredEvent } from './runner.ts';

/**
 * The detailed trace of ONE run (Phase 7, ADR-024), built from the hub's own stored events: the `turn` rows the runner writes (one per model call:
 * tokens and the prompt size, redacted before they were stored), the `tool` / `tool_result` rows (names, arrival times, size of the output) and the
 * run-level `usage`. Nothing here reads a transcript or a foreign agent file, and nothing returns the text of a tool input or output: a trace holds
 * names, numbers and times only. Everything is bounded: rows read, tools listed per turn, turns per page.
 *
 * Times are the hub's arrival times (the stored `ts`): a tool's duration is the gap between its call line and its result line, a turn lasts until the
 * next turn starts. That is inferred from the stream, not a stopwatch inside the CLI.
 */
export interface TraceTool { name: string; ms: number; ok: boolean; bytes: number; /** No result was seen (the run stopped first): `ok` is false but the tool did not fail. */ open?: true }
export interface Turn {
  n: number; startedAt: string; ms: number; model: string; effort?: string;
  tokens: { newIn: number; cachedIn: number; out: number; reasoning: number };
  /** Prompt size of this call; 0 = not measured (Codex reports no per-call size). */
  context: number; cacheHit: number; tools: TraceTool[]; toolsMore?: number; costUsd: number | null;
}
export interface Trace { turns: Turn[]; totals: Turn['tokens'] & { ms: number; costUsd: number | null }; slowest: { name: string; ms: number; turn: number }[] }

export const MAX_TRACE_ROWS = 50_000;     // stored rows read for one trace
export const MAX_TOOLS_PER_TURN = 100;    // tools listed in one turn; the rest are counted in `toolsMore`
export const MAX_PAGE_TURNS = 200;
const MAX_PENDING = 2000, SLOWEST = 5, TOKEN_CAP = 1e12;

const obj = (d: unknown): Record<string, unknown> => (d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {});
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), TOKEN_CAP) : 0);
/** A name from stored data: redacted AGAIN (a row written before the sanitizer existed must not leak) and capped. */
const label = (v: unknown, n: number): string => (typeof v === 'string' ? redact(v).slice(0, n) : '');
const ms = (ts: string): number => { const t = Date.parse(ts); return Number.isFinite(t) ? t : Number.NaN; };
const span = (from: number, to: number): number => (Number.isFinite(from) && Number.isFinite(to) && to > from ? Math.round(to - from) : 0);

interface Pending { tool: TraceTool | null; name: string; at: number; turn: number }
export interface TraceOpts { model?: string; effort?: string; /** Tests: a different price lookup. Default: the hub's price table (null when the model has no row). */ price?: (model: string, t: Tokens) => number | null }

export function buildTrace(events: StoredEvent[], o: TraceOpts = {}): Trace {
  const price = o.price ?? ((m: string, t: Tokens) => costUsd(m, t));
  const hasTurns = events.some((e) => e.kind === 'turn');
  const turns: Turn[] = [], slowest: Trace['slowest'] = [], pending = new Map<string, Pending[]>();
  let pendingN = 0, model = label(o.model, 100), firstTs = Number.NaN, firstIso = '', lastTs = Number.NaN, runCost: number | null = null;
  let cur: Turn | undefined, curStart = Number.NaN, closedAt = Number.NaN, closedIso = '';

  const open = (startIso: string, start: number, tokens: Turn['tokens'], context: number): Turn => {
    const t: Turn = { n: turns.length + 1, startedAt: startIso, ms: 0, model, ...(o.effort ? { effort: label(o.effort, 20) } : {}), tokens, context, cacheHit: 0, tools: [], costUsd: null };
    turns.push(t); cur = t; curStart = start; return t;
  };
  const close = (end: number, endIso: string): void => {
    if (!cur) return;
    cur.ms = span(curStart, end);
    const { newIn, cachedIn } = cur.tokens;
    cur.cacheHit = newIn + cachedIn > 0 ? cachedIn / (newIn + cachedIn) : 0;
    cur.costUsd = cur.model ? price(cur.model, { uncachedIn: newIn, cachedIn, out: cur.tokens.out }) : null;
    cur = undefined; closedAt = end; closedIso = endIso;
  };
  const zero = (): Turn['tokens'] => ({ newIn: 0, cachedIn: 0, out: 0, reasoning: 0 });

  for (const e of events) {
    const d = obj(e.data), t = ms(e.ts);
    if (!Number.isFinite(firstTs) && Number.isFinite(t)) { firstTs = t; firstIso = e.ts; }
    if (Number.isFinite(t)) lastTs = t;
    switch (e.kind) {
      case 'session': { const m = label(d['model'], 100); if (m) model = m; break; }
      case 'turn': {
        close(t, e.ts);
        open(e.ts, t, { newIn: whole(d['newIn']), cachedIn: whole(d['cachedIn']), out: whole(d['out']), reasoning: whole(d['reasoning']) }, whole(d['context']));
        break;
      }
      case 'tool': {
        if (!cur) open(closedIso || firstIso, Number.isFinite(closedAt) ? closedAt : firstTs, zero(), 0);   // a tool before any turn row (or after the last stored one): a step with no measured tokens
        const c = cur as Turn, name = label(d['name'], 100) || 'unknown', id = typeof d['id'] === 'string' ? d['id'].slice(0, 200) : '';
        const tool: TraceTool | null = c.tools.length < MAX_TOOLS_PER_TURN ? { name, ms: 0, ok: false, bytes: 0, open: true } : null;
        if (tool) c.tools.push(tool); else c.toolsMore = (c.toolsMore ?? 0) + 1;
        if (pendingN < MAX_PENDING) { const q = pending.get(id) ?? []; q.push({ tool, name, at: t, turn: c.n }); pending.set(id, q); pendingN++; }
        break;
      }
      case 'tool_result': {
        const id = typeof d['id'] === 'string' ? d['id'].slice(0, 200) : '', q = pending.get(id), p = q?.shift();
        if (!p) break;
        pendingN--; if (q && !q.length) pending.delete(id);
        const dur = span(p.at, t), bytes = typeof d['bytes'] === 'number' ? whole(d['bytes']) : typeof d['body'] === 'string' ? Buffer.byteLength(d['body']) : 0;
        if (p.tool) { p.tool.ms = dur; p.tool.ok = !d['isError']; p.tool.bytes = bytes; delete p.tool.open; }
        if (slowest.length < SLOWEST || dur > (slowest.at(-1)?.ms ?? 0)) { slowest.push({ name: p.name, ms: dur, turn: p.turn }); slowest.sort((a, b) => b.ms - a.ms); slowest.length = Math.min(slowest.length, SLOWEST); }
        break;
      }
      case 'usage': {
        if (hasTurns) { const c = d['costUsd']; if (typeof c === 'number' && Number.isFinite(c) && c >= 0) runCost = c; break; }   // a Claude run: the per-call numbers are in the turn rows, this line is the whole run
        // No turn rows (Codex, or a run recorded before Phase 7): a usage event closes the turn that came before it.
        const tokens = { newIn: whole(d['uncachedIn']), cachedIn: whole(d['cachedIn']), out: whole(d['out']), reasoning: whole(d['reasoning']) };
        if (!cur) open(closedIso || firstIso, Number.isFinite(closedAt) ? closedAt : firstTs, tokens, 0); else cur.tokens = tokens;
        close(t, e.ts);
        const c = d['costUsd']; if (typeof c === 'number' && Number.isFinite(c) && c >= 0) runCost = (runCost ?? 0) + c;
        break;
      }
      default: break;
    }
  }
  close(lastTs, '');
  const totals = turns.reduce((a, x) => ({ newIn: a.newIn + x.tokens.newIn, cachedIn: a.cachedIn + x.tokens.cachedIn, out: a.out + x.tokens.out, reasoning: a.reasoning + x.tokens.reasoning }), zero());
  const costs = turns.map((x) => x.costUsd);
  const cost = runCost !== null ? runCost : turns.length && costs.every((c): c is number => c !== null) ? costs.reduce((a, c) => a + c, 0) : null;
  return { turns, totals: { ...totals, ms: span(firstTs, lastTs), costUsd: cost }, slowest };
}

/**
 * The rows a trace needs, read WITHOUT their bulk: a tool row comes back as id + name, a tool result as id + error flag + size of its body in
 * bytes. The tool input and the output text stay in the database (they can be 64 KB each). At most `max` rows; `truncated` says there were more.
 */
export function readTraceEvents(db: Db, runId: string, max = MAX_TRACE_ROWS): { events: StoredEvent[]; truncated: boolean } {
  const rows = db.prepare(`SELECT seq, ts, kind, CASE kind
      WHEN 'tool' THEN json_object('id', json_extract(data, '$.id'), 'name', json_extract(data, '$.name'))
      WHEN 'tool_result' THEN json_object('id', json_extract(data, '$.id'), 'isError', json_extract(data, '$.isError'), 'bytes', length(CAST(json_extract(data, '$.body') AS BLOB)))
      ELSE data END AS data
    FROM run_event WHERE run_id = ? AND kind IN ('session', 'turn', 'tool', 'tool_result', 'usage', 'end') ORDER BY seq LIMIT ?`).all(runId, max + 1) as unknown as { seq: number; ts: string; kind: string; data: string }[];
  const events: StoredEvent[] = [];
  for (const r of rows.slice(0, max)) { let data: unknown = {}; try { data = JSON.parse(r.data); } catch { /* a damaged row is an empty one */ } events.push({ seq: r.seq, ts: r.ts, kind: r.kind, data }); }
  return { events, truncated: rows.length > max };
}

const int = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d);
/** One page of turns: `after` is the number of the last turn already seen; `next` is the number to pass for the following page (null at the end). */
export function pageTurns(turns: Turn[], o: { after?: number; limit?: number }): { turns: Turn[]; next: number | null; total: number } {
  const after = Math.max(0, int(o.after, 0)), limit = Math.min(MAX_PAGE_TURNS, Math.max(1, int(o.limit, 100)));
  const start = turns.findIndex((t) => t.n > after);
  const page = start < 0 ? [] : turns.slice(start, start + limit);
  const more = start >= 0 && start + limit < turns.length;
  return { turns: page, next: more ? (page.at(-1)?.n ?? null) : null, total: turns.length };
}

/** The download: one JSON object per line (turns, then the totals). No text of any tool input or output. */
export const traceJsonl = (t: Trace): string => t.turns.map((x) => JSON.stringify({ type: 'turn', ...x })).concat(JSON.stringify({ type: 'totals', ...t.totals, slowest: t.slowest })).join('\n') + '\n';
