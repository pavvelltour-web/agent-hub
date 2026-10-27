import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../history/store.ts';
import { canonicalModel } from './econ.ts';
import { priceTable, type PriceTable } from './prices.ts';

/**
 * The live context gauge (Phase 7.2, ADR-024). The numbers are the per-call prompt sizes the hub stores as `turn` rows (the `context` event of ADR-018):
 * what the NEXT call must carry, not the run total. The window of a model comes only from the price table (`window` on a row); nothing is guessed.
 */
/** One number for the gauge and for the runner's stop (ADR-018): `CONTEXT_LIMIT` in runner.ts is this. */
export const HANDOFF_AT = 250_000;
/** The gauge turns amber here and red at `HANDOFF_AT`. */
export const AMBER_AT = 200_000;
/** The prompt cache lives 5 minutes (the plan's figure, Anthropic's default); from `WARM_SEC` on the user is told that a pause makes the next message dearer. */
export const CACHE_TTL_SEC = 300;
export const WARM_SEC = 120;

export interface Breakdown { system: number; rules: number; skills: number; conversation: number; used: number; window: number | null; turnsLeft: number | null; handoffAt: typeof HANDOFF_AT }

const TOKEN_CAP = 1e12;
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), TOKEN_CAP) : 0);

/**
 * Where the context went. `firstCall` is the size of the first model call of the thread: it holds the system prompt, the tool list, the rules and the skill list
 * (measured). `rulesTokens` and `skillsTokens` are ESTIMATES of two parts of it, so `system` = first call − rules − skills is what is left, never a guess on top.
 * The parts always add up to `used` (an estimate larger than what was measured is cut). `turns` = model calls so far; `turnsLeft` = calls until `HANDOFF_AT` at the
 * mean growth per call, or null when there are fewer than two calls or no growth. `window` null = unknown.
 */
export function contextBreakdown(o: { firstCall: number; rulesTokens: number; skillsTokens: number; lastContext: number; window: number | null; turns: number }): Breakdown {
  const used = whole(o.lastContext), first = whole(o.firstCall), turns = whole(o.turns);
  const fixed = Math.min(first, used);
  const rules = Math.min(whole(o.rulesTokens), fixed), skills = Math.min(whole(o.skillsTokens), fixed - rules);
  const growth = turns >= 2 && used > first ? (used - first) / (turns - 1) : 0;
  const window = whole(o.window) || null;
  return { system: fixed - rules - skills, rules, skills, conversation: used - fixed, used, window, turnsLeft: growth > 0 ? Math.max(0, Math.floor((HANDOFF_AT - used) / growth)) : null, handoffAt: HANDOFF_AT };
}

export type Level = 'ok' | 'amber' | 'red';
export const contextLevel = (used: number): Level => { const u = whole(used); return u >= HANDOFF_AT ? 'red' : u >= AMBER_AT ? 'amber' : 'ok'; };

export type Cache = { state: 'warm' } | { state: 'cooling'; secondsLeft: number } | { state: 'cold' };
/** `ageSec` = seconds since the last model call. */
export function cacheState(ageSec: number): Cache {
  const a = typeof ageSec === 'number' && Number.isFinite(ageSec) && ageSec > 0 ? ageSec : 0;
  if (a <= WARM_SEC) return { state: 'warm' };
  return a < CACHE_TTL_SEC ? { state: 'cooling', secondsLeft: Math.ceil(CACHE_TTL_SEC - a) } : { state: 'cold' };
}

/** The window of a model in tokens, from the price table row (`window`), or null. The bundled table names none: set one in `<hub home>/prices.json`. */
export function modelWindow(model: string | null | undefined, table: PriceTable = priceTable()): number | null {
  const id = canonicalModel(model);
  const w = id ? table.models.get(id)?.window : undefined;
  return typeof w === 'number' && w > 0 ? w : null;
}

export interface ThreadContext { turns: number; firstCall: number | null; used: number | null; lastTs: string | null }
const RUN_ID = /^r[0-9a-z]{2,40}$/;
const ctxOf = (data: string): number => { try { return whole((JSON.parse(data) as { context?: unknown }).context); } catch { return 0; } };

/**
 * What the stored `turn` rows say about the chat thread that `runId` belongs to. A thread is the run and the runs it resumed (`resume_of`, at most 50, no loops):
 * the baseline is the FIRST call of its oldest run (a resumed run's first call already carries the whole earlier conversation), `used` is the newest call of the
 * newest run that made one, `turns` counts calls over the thread. A handoff starts a fresh session and so a fresh thread. Undefined for an unknown run.
 */
export function readContext(db: Db, runId: string): ThreadContext | undefined {
  const parent = db.prepare('SELECT resume_of AS resumeOf FROM run WHERE id = ?');
  const chain: string[] = [], seen = new Set<string>();
  for (let id: string | null | undefined = runId; id && RUN_ID.test(id) && !seen.has(id) && chain.length < 50;) {
    const r = parent.get(id) as { resumeOf: string | null } | undefined;
    if (!r) break;
    seen.add(id); chain.push(id); id = r.resumeOf;
  }
  if (!chain.length) return undefined;
  const span = db.prepare("SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM run_event WHERE run_id = ? AND kind = 'turn'");
  const at = db.prepare("SELECT ts, data FROM run_event WHERE run_id = ? AND kind = 'turn' AND seq = ?");
  const out: ThreadContext = { turns: 0, firstCall: null, used: null, lastTs: null };
  for (const id of chain) {   // newest first: the last run with a call gives `used`, each older one moves `firstCall` back
    const s = span.get(id) as { n: number; lo: number; hi: number };
    if (!s.n) continue;
    out.turns += s.n;
    if (out.used === null) { const hi = at.get(id, s.hi) as { ts: string; data: string }; out.used = ctxOf(hi.data); out.lastTs = hi.ts; }
    out.firstCall = ctxOf((at.get(id, s.lo) as { data: string }).data);
  }
  return out;
}

const MAX_RULES_BYTES = 1_000_000;
/**
 * Estimate (bytes / 4, rounded up) of the rule files the agent loads from a folder: AGENTS.md and CLAUDE.md. Only the SIZE of a regular file is read, never its text
 * (a link or a directory counts as 0). An estimate, shown as one.
 */
export function rulesTokens(dir: string): number {
  let bytes = 0;
  for (const name of ['AGENTS.md', 'CLAUDE.md']) { try { const st = lstatSync(join(dir, name)); if (st.isFile()) bytes += Math.min(st.size, MAX_RULES_BYTES); } catch { /* none */ } }
  return Math.ceil(bytes / 4);
}
