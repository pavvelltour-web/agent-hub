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

export interface Breakdown { system: number; rules: number; skills: number; conversation: number; used: number; window: number | null; turnsLeft: number | null; handoffAt: number }

const TOKEN_CAP = 1e12;
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), TOKEN_CAP) : 0);

/**
 * Where the context went. `firstCall` is the size of the first model call of the thread: it holds the system prompt, the tool list, the rules and the skill list
 * (measured). `rulesTokens` and `skillsTokens` are ESTIMATES of two parts of it, so `system` = first call − rules − skills is what is left, never a guess on top.
 * The parts always add up to `used` (an estimate larger than what was measured is cut). `turns` = model calls so far; `turnsLeft` = calls until `HANDOFF_AT` at the
 * mean growth per call, or null when there are fewer than two calls or no growth. `window` null = unknown.
 */
export function contextBreakdown(o: { firstCall: number; rulesTokens: number; skillsTokens: number; lastContext: number; window: number | null; turns: number; /** The limit the runner really uses (default `HANDOFF_AT`); 0 = no limit, then there is no `turnsLeft`. */ limit?: number }): Breakdown {
  const used = whole(o.lastContext), first = whole(o.firstCall), turns = whole(o.turns);
  const fixed = Math.min(first, used);
  const rules = Math.min(whole(o.rulesTokens), fixed), skills = Math.min(whole(o.skillsTokens), fixed - rules);
  const growth = turns >= 2 && used > first ? (used - first) / (turns - 1) : 0;
  const window = whole(o.window) || null, limit = o.limit === undefined ? HANDOFF_AT : whole(o.limit);
  return { system: fixed - rules - skills, rules, skills, conversation: used - fixed, used, window, turnsLeft: growth > 0 && limit > 0 ? Math.max(0, Math.floor((limit - used) / growth)) : null, handoffAt: limit };
}

export type Level = 'ok' | 'amber' | 'red';
/** Red from the limit (the runner's, default 250K; with no limit the default line still marks a large context), amber from 200K or 80 % of a lower limit. */
export const contextLevel = (used: number, limit: number = HANDOFF_AT): Level => {
  const u = whole(used), red = whole(limit) || HANDOFF_AT, amber = Math.min(AMBER_AT, red * 0.8);
  return u >= red ? 'red' : u >= amber ? 'amber' : 'ok';
};

/**
 * What the runner does when one call's prompt passes the limit (ADR-018), as ONE predicate that the runner and the gauge both call so they cannot drift:
 * `restart` = the hub stops the run and starts a fresh session from a card (a hub task folder, chain not capped, not told `autoContinue: false`);
 * `warn` = the user is told and must continue by hand (a chat in the user's own folder, a reviewer, a capped chain, a cascade step: the hub may stop the run but starts nothing);
 * `off` = the watch is switched off (`limit` 0).
 */
export type Handoff = 'restart' | 'warn' | 'off';
export function handoffMode(o: { limit: number; branch: string | null; isolated: boolean; capped: boolean; autoContinue?: boolean | undefined }): Handoff {
  if (!(o.limit > 0)) return 'off';
  return hubOwnsFolder(o.branch, o.isolated) && !o.capped && o.autoContinue !== false ? 'restart' : 'warn';
}
/** The hub stops a run at the limit only in a hub task worktree (`branch`), never a reviewer (`isolated`): the only place it commits a checkpoint (ADR-014/018). */
export const hubOwnsFolder = (branch: string | null | undefined, isolated: boolean): boolean => !!branch && !isolated;
/** Sessions of one task already stopped for context size, counted back along `handoffOf` (a fresh session after a context stop is `handoffOf` the stopped one). */
export const CONTEXT_CHAIN_MAX = 3;
export function contextChainDepth(get: (id: string) => { outcome: string | null; handoffOf: string | null } | undefined, handoffOf: string | null | undefined): number {
  let depth = 0;
  for (let p = handoffOf ? get(handoffOf) : undefined; p?.outcome === 'context' && depth < CONTEXT_CHAIN_MAX; p = p.handoffOf ? get(p.handoffOf) : undefined) depth++;
  return depth;
}

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
 * Estimate (bytes / 4, rounded up) of the rule file the agent loads from a folder: CLAUDE.md for Claude, AGENTS.md for Codex (each reads only its own). Only the SIZE of a
 * regular file is read, never its text: a link or a directory counts as 0 (so a symlinked CLAUDE.md, and `@AGENTS.md` imports inside it, are not counted: the panel says «≈»).
 */
export function rulesTokens(dir: string, agent: 'claude' | 'codex'): number {
  let bytes = 0;
  for (const name of [agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md']) { try { const st = lstatSync(join(dir, name)); if (st.isFile()) bytes += Math.min(st.size, MAX_RULES_BYTES); } catch { /* none */ } }
  return Math.ceil(bytes / 4);
}
