import type { Db } from '../history/store.ts';
import { bundledCheckedAt, priceTable, tierFor } from './prices.ts';

// ---------- prices (USD per 1M tokens): registry/prices.json + the user's overrides, see prices.ts ----------
export type { Price } from './prices.ts';
/** Day the bundled Claude prices were last read off Anthropic's pricing page (the newest `checked` row). GPT is a recorded figure with its own date in the table. */
export const PRICES_VERIFIED_AT: string = bundledCheckedAt();
// Bare aliases (what the CLI accepts: `--model sonnet`) mean the current version of that family.
const ALIAS: [RegExp, string][] = [[/^fable$|fable.?5.?1/i, 'claude-fable-5-1'], [/^opus$|opus.?5.?5/i, 'claude-opus-5-5'], [/^sonnet$|sonnet.?5.?5/i, 'claude-sonnet-5-5'], [/^haiku$|haiku.?5.?5/i, 'claude-haiku-5-5'], [/gpt.?6.?1.?sol/i, 'gpt-6.1-sol']];

export const canonicalModel = (name: string | null | undefined): string | null => (name ? ALIAS.find(([re]) => re.test(name))?.[1] ?? name : null);
export interface Tokens { uncachedIn: number; cachedIn: number; out: number }

/** API-equivalent dollars, or null when the model's price is not known. Cache writes are counted as input (an approximation noted in docs). */
export function costUsd(model: string | null | undefined, t: Tokens): number | null {
  const m = canonicalModel(model);
  const entry = m ? priceTable().models.get(m) : undefined;
  if (!entry) return null;
  const price = tierFor(entry, t.uncachedIn + t.cachedIn);
  return (t.uncachedIn * price.input + t.cachedIn * price.cacheRead + t.out * price.output) / 1e6;
}

// ---------- token profiles measured from the user's own history ----------
export const W_CACHED = 0.1, W_OUT = 5;
export const weighted = (t: Tokens): number => (t.uncachedIn + W_CACHED * t.cachedIn + W_OUT * t.out) / 1e6;

export interface Profile { n: number; p50: Tokens; p75: Tokens; p90: Tokens; mean: Tokens; source: 'history' | 'default' }
/** Defaults = measured on the author's Codex history (338 sessions): median 0.15M/4.78M/0.02M, p75 0.31/11.25/0.05, p90 0.94/35.6/0.13. */
export const DEFAULT_PROFILE: Profile = {
  n: 0, source: 'default',
  p50: { uncachedIn: 150_000, cachedIn: 4_780_000, out: 20_000 }, p75: { uncachedIn: 310_000, cachedIn: 11_250_000, out: 50_000 },
  p90: { uncachedIn: 940_000, cachedIn: 35_620_000, out: 130_000 }, mean: { uncachedIn: 600_000, cachedIn: 27_400_000, out: 103_000 },
};
const pct = (xs: number[], p: number): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number; };

export function profileFromHistory(db: Db, agent?: string): Profile {
  const rows = db.prepare(`SELECT uncached_in AS u, cached_in AS c, out_tokens AS o FROM session WHERE parent_id IS NULL AND msg_count >= 5 ${agent ? 'AND agent = ?' : ''} AND (uncached_in + cached_in) > 0`).all(...(agent ? [agent] : [])) as unknown as { u: number; c: number; o: number }[];
  if (rows.length < 10) return DEFAULT_PROFILE;
  const at = (p: number): Tokens => ({ uncachedIn: pct(rows.map((r) => r.u), p), cachedIn: pct(rows.map((r) => r.c), p), out: pct(rows.map((r) => r.o), p) });
  const avg = (k: 'u' | 'c' | 'o'): number => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  return { n: rows.length, source: 'history', p50: at(0.5), p75: at(0.75), p90: at(0.9), mean: { uncachedIn: avg('u'), cachedIn: avg('c'), out: avg('o') } };
}

/** Runs needed before a measurement of one effort is trusted (same bar as the router's MIN_RUNS). */
export const MIN_EFFORT_RUNS = 3;
/**
 * Token profile of one agent at one effort, from the hub's own finished runs (the run table records the effort the hub asked for) and, for sessions
 * the hub did not start, the effort the agent logged (Codex logs it, Claude does not). Reviewer runs and interrupted runs are left out.
 * Fewer than MIN_EFFORT_RUNS rows: the default profile, so callers fall back to the prior multiplier.
 */
export function effortProfile(db: Db, agent: string, effort: string): Profile {
  const runs = db.prepare(`SELECT r.tokens_in AS tin, r.tokens_cached AS tc, r.tokens_out AS o FROM run r WHERE r.agent = ? AND lower(r.effort) = ? AND r.outcome IS NOT NULL AND r.outcome NOT IN ('interrupted', 'context') AND ${NOT_REVIEWER_SQL} AND (r.tokens_in IS NOT NULL OR r.tokens_out IS NOT NULL)`).all(agent, effort.toLowerCase()) as unknown as { tin: number | null; tc: number | null; o: number | null }[];
  const sessions = db.prepare(`SELECT s.uncached_in AS u, s.cached_in AS c, s.out_tokens AS o FROM session s WHERE s.agent = ? AND lower(s.effort) = ? AND s.parent_id IS NULL AND s.msg_count >= 5 AND (s.uncached_in + s.cached_in) > 0 AND NOT EXISTS (SELECT 1 FROM run r WHERE r.agent = s.agent AND r.session_native_id = s.native_id)`).all(agent, effort.toLowerCase()) as unknown as { u: number; c: number; o: number }[];
  const rows = [
    ...runs.map((r) => ({ u: Math.max(0, (r.tin ?? 0) - (r.tc ?? 0)), c: r.tc ?? 0, o: r.o ?? 0 })),
    ...sessions.map((r) => ({ u: r.u, c: r.c, o: r.o })),
  ];
  if (rows.length < MIN_EFFORT_RUNS) return DEFAULT_PROFILE;
  const at = (p: number): Tokens => ({ uncachedIn: pct(rows.map((r) => r.u), p), cachedIn: pct(rows.map((r) => r.c), p), out: pct(rows.map((r) => r.o), p) });
  const avg = (k: 'u' | 'c' | 'o'): number => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  return { n: rows.length, source: 'history', p50: at(0.5), p75: at(0.75), p90: at(0.9), mean: { uncachedIn: avg('u'), cachedIn: avg('c'), out: avg('o') } };
}

/** Measured profiles for the router, keyed `agent:effort`; only those with enough runs (the rest are left to the prior multiplier). */
export function effortProfiles(db: Db): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  for (const agent of ['claude', 'codex']) for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) { const p = effortProfile(db, agent, e); if (p.source === 'history') out[`${agent}:${e}`] = p; }
  return out;
}

// ---------- weekly-limit calibration ----------
export interface Calib { lowMwPerPct: number; highMwPerPct: number; n: number; source: 'measured' | 'prior' | 'none' }
export const CODEX_PRIOR: Calib = { lowMwPerPct: 1, highMwPerPct: 8, n: 0, source: 'prior' };

/** Weighted Mtok per 1% of the weekly limit, from consecutive limit snapshots of one window. Needs ≥5 usable intervals, else the (wide) prior. */
export function calibrate(db: Db, agent: string): Calib {
  const snaps = db.prepare('SELECT ts, used_percent AS p, resets_at AS r FROM limit_snapshot WHERE agent = ? AND used_percent IS NOT NULL ORDER BY ts').all(agent) as unknown as { ts: string; p: number; r: number }[];
  const ratios: number[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1] as (typeof snaps)[number], b = snaps[i] as (typeof snaps)[number];
    if (a.r !== b.r || b.p - a.p < 2) continue;
    const u = db.prepare('SELECT COALESCE(SUM(u.uncached_in),0) AS ui, COALESCE(SUM(u.cached_in),0) AS ci, COALESCE(SUM(u.out_tokens),0) AS o FROM usage_event u JOIN session s ON s.id = u.session_id WHERE s.agent = ? AND u.ts > ? AND u.ts <= ?').get(agent, a.ts, b.ts) as unknown as { ui: number; ci: number; o: number };
    const w = weighted({ uncachedIn: u.ui, cachedIn: u.ci, out: u.o });
    if (w > 0.05) ratios.push(w / (b.p - a.p));
  }
  if (ratios.length >= 5) return { lowMwPerPct: pct(ratios, 0.25), highMwPerPct: pct(ratios, 0.75), n: ratios.length, source: 'measured' };
  return agent === 'codex' ? { ...CODEX_PRIOR, n: ratios.length } : { lowMwPerPct: 0, highMwPerPct: 0, n: ratios.length, source: 'none' };
}

// ---------- estimate ----------
export interface Estimate { tokens: { low: Tokens; high: Tokens }; usd: { low: number; high: number } | null; percent: { low: number; high: number } | null; confidence: 'low' | 'medium'; notes: string[] }

/** Range, never a point: low = typical session (p50), high = heavy (p75) at this model. */
export function estimate(profile: Profile, model: string, calib: Calib, scale = 1): Estimate {
  const sc = (t: Tokens): Tokens => ({ uncachedIn: t.uncachedIn * scale, cachedIn: t.cachedIn * scale, out: t.out * scale });
  const low = sc(profile.p50), high = sc(profile.p75);
  const cl = costUsd(model, low), ch = costUsd(model, high);
  const notes: string[] = [];
  if (cl == null) notes.push(`Цена модели ${model} не проверена, поэтому доллары не считаются.`);
  if (calib.source === 'none') notes.push('Замеров лимита для этого агента ещё нет, поэтому доля лимита не известна.');
  if (calib.source === 'prior') notes.push('Доля лимита пока грубая прикидка; станет точнее после нескольких запусков.');
  if (profile.source === 'default') notes.push('Расход токенов пока взят из средних значений, а не из вашей истории.');
  const wl = weighted(low), wh = weighted(high);
  return {
    tokens: { low, high }, usd: cl != null && ch != null ? { low: round(cl), high: round(ch) } : null,
    percent: calib.source === 'none' ? null : { low: round1(wl / calib.highMwPerPct), high: round1(wh / calib.lowMwPerPct) },
    confidence: calib.source === 'measured' && profile.source === 'history' ? 'medium' : 'low', notes,
  };
}
const round = (x: number): number => Math.round(x * 100) / 100;
const round1 = (x: number): number => Math.round(x * 10) / 10;

// ---------- observed quality: what finished runs say about each model ----------
/**
 * What a task-branch run (`outcome = 'review'`) really ended as, from the latest review of its branch:
 * - `passed` -> 'done' (the gate let it through);
 * - `reconsider` (three rounds did not converge, never approved) -> 'failed';
 * - anything else (no review yet, open, waiting for a human, running) -> 'review' = pending: it says nothing yet and is left out of success stats.
 * Conservative on purpose: a branch is not a success until the gate passes it, and only a dead end counts against the model.
 */
export function settledOutcome(outcome: string | null, reviewState: string | null | undefined): string | null {
  if (outcome !== 'review') return outcome;
  return reviewState === 'passed' ? 'done' : reviewState === 'reconsider' ? 'failed' : 'review';
}
/** info_json of the same latest review: its `checks` hold the gate's clean-copy check results. */
const REVIEW_INFO_SQL = "(SELECT v.info_json FROM review v JOIN run u ON u.id = v.run_id WHERE u.cwd = r.cwd AND u.branch = r.branch ORDER BY v.rowid DESC LIMIT 1)";
/** The gate rejected the work: three rounds did not converge, or one of its checks (run in a clean copy) was red. */
function gateRejected(rstate: string | null | undefined, info: string | null | undefined): boolean {
  if (rstate === 'reconsider') return true;
  try { const c = (JSON.parse(info ?? 'null') as { checks?: { ok?: unknown }[] } | null)?.checks; return Array.isArray(c) && c.some((x) => x?.ok === false); } catch { return false; }
}
/** SQL for `run r`: the state of the latest review of the run's branch (same folder + branch), or NULL. */
const REVIEW_STATE_SQL = "(SELECT v.state FROM review v JOIN run u ON u.id = v.run_id WHERE u.cwd = r.cwd AND u.branch = r.branch ORDER BY v.rowid DESC LIMIT 1)";
/** Review-gate reviewer runs are plumbing, not the user's work: never part of stats, routing or shared cases. */
export const NOT_REVIEWER_SQL = "(r.work_mode IS NULL OR r.work_mode != 'gate-reviewer')";

/** Score of a run whose verify command passed / failed, and of a `done` run that nothing verified. A user's rating (0 / 0.5 / 1) outranks all three. */
export const VERIFY_PASS = 0.9, VERIFY_FAIL = 0.1, DONE_UNVERIFIED = 0.5;
/**
 * 0..1 per finished run, by the order of evidence: the user's rating > the verify result (`verify_passed`: 1 green, 0 red, null = none ran) > the
 * outcome. Without a rating or a verify result, "done" is a weak yes (0.5: nothing checked it) and "failed" a no. Limit stops and manual stops say
 * nothing about quality, and neither does a branch still in review (`review` = pending, see settledOutcome): pass the settled outcome. A verify
 * result outranks a PENDING review but never a rejected one: if the review ended `reconsider`, or a clean-copy check of the gate failed
 * (`gateRejected`), a verify pass is capped at VERIFY_FAIL (the work did not hold up); a run whose settled outcome is `failed` is rejected too.
 */
export function runScore(outcome: string | null, rating: number | null, verifyPassed: number | boolean | null = null, gateRejected = false): number | null {
  if (rating === 2) return 1; if (rating === 1) return 0.5; if (rating === 0) return 0;
  if (verifyPassed === 1 || verifyPassed === true) return gateRejected || outcome === 'failed' ? VERIFY_FAIL : VERIFY_PASS;
  if (verifyPassed === 0 || verifyPassed === false) return VERIFY_FAIL;
  if (outcome === 'done') return DONE_UNVERIFIED; if (outcome === 'failed') return 0;
  return null;
}
/** Keys `cls|model` (every effort together) and `cls|model|effort` (that pair only). */
export function modelStats(db: Db): Record<string, { n: number; score: number }> {
  const rows = db.prepare(`SELECT r.cls, r.model, r.effort, r.outcome, r.rating, r.verify_passed AS verify, ${REVIEW_STATE_SQL} AS rstate, ${REVIEW_INFO_SQL} AS rinfo FROM run r WHERE r.cls IS NOT NULL AND r.model IS NOT NULL AND r.outcome IS NOT NULL AND ${NOT_REVIEWER_SQL}`).all() as unknown as { cls: string; model: string; effort: string | null; outcome: string; rating: number | null; verify: number | null; rstate: string | null; rinfo: string | null }[];
  const out: Record<string, { n: number; score: number }> = {};
  for (const r of rows) {
    const sc = runScore(settledOutcome(r.outcome, r.rstate), r.rating, r.verify, gateRejected(r.rstate, r.rinfo)); if (sc == null) continue;
    const m = canonicalModel(r.model) ?? r.model;
    const key = `${r.cls}|${/opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : /fable/i.test(m) ? 'fable' : 'gpt'}`;
    // per model (all efforts) and, when the run recorded its effort, per (model, effort) pair
    for (const k of r.effort ? [key, `${key}|${r.effort.toLowerCase()}`] : [key]) { const x = out[k] ?? { n: 0, score: 0 }; x.n++; x.score += sc; out[k] = x; }
  }
  return out;
}

// ---------- estimate vs actual ----------
export interface OutcomeRow { cls: string; model: string; effort: string; runs: number; done: number; limit: number; failed: number; pending: number; contextStops: number; actualMw: number; estLowMw: number | null; estHighMw: number | null; withinRange: number; withEstimate: number; costUsd: number | null; costEstimated: boolean }

/**
 * Finished runs grouped by task class, model and effort: how often they succeed and whether the shown estimate held (weighted Mtok). A branch still in review is `pending`, not done.
 * `costUsd` = mean API-equivalent dollars of the group's settled runs (done + failed): the run's own recorded cost, else the price table applied to its tokens
 * (`costEstimated`); null when any settled run has neither (unknown, never 0).
 */
export function outcomes(db: Db): OutcomeRow[] {
  const rows = db.prepare(`SELECT r.cls, r.model, r.effort, r.outcome, ${REVIEW_STATE_SQL} AS rstate, r.tokens_in AS tin, r.tokens_cached AS tc, r.tokens_out AS tout, r.cost_usd AS cost, r.est_json AS est FROM run r WHERE r.outcome IS NOT NULL AND r.outcome != 'interrupted' AND ${NOT_REVIEWER_SQL}`).all() as unknown as { cls: string | null; model: string | null; effort: string | null; outcome: string; rstate: string | null; tin: number | null; tc: number | null; tout: number | null; cost: number | null; est: string | null }[];
  const g = new Map<string, OutcomeRow & { lowSum: number; highSum: number; actualSum: number; costSum: number; settled: number; unpriced: number }>();
  for (const r of rows) {
    const key = [r.cls ?? 'unclassified', canonicalModel(r.model) ?? r.model ?? 'unknown', r.effort ?? '-'].join('|');
    const o = g.get(key) ?? { cls: r.cls ?? 'unclassified', model: canonicalModel(r.model) ?? r.model ?? 'unknown', effort: r.effort ?? '-', runs: 0, done: 0, limit: 0, failed: 0, pending: 0, contextStops: 0, actualMw: 0, estLowMw: null, estHighMw: null, withinRange: 0, withEstimate: 0, costUsd: null, costEstimated: false, lowSum: 0, highSum: 0, actualSum: 0, costSum: 0, settled: 0, unpriced: 0 };
    const out = settledOutcome(r.outcome, r.rstate);
    o.runs++;
    if (out === 'context') { o.contextStops++; g.set(key, o); continue; }   // stopped for context size and continued elsewhere: partial work, its tokens say nothing about what the task costs
    if (out === 'done') o.done++; else if (out === 'review') o.pending++; else if (out === 'limit') o.limit++; else if (out === 'failed') o.failed++;
    const cached = r.tc ?? 0;
    const actual = weighted({ uncachedIn: Math.max(0, (r.tin ?? 0) - cached), cachedIn: cached, out: r.tout ?? 0 });
    o.actualSum += actual;
    if (out === 'done' || out === 'failed') {
      o.settled++;
      const own = typeof r.cost === 'number' && Number.isFinite(r.cost) ? r.cost : null;
      const priced = own ?? costUsd(r.model, { uncachedIn: Math.max(0, (r.tin ?? 0) - cached), cachedIn: cached, out: r.tout ?? 0 });
      if (priced == null) o.unpriced++; else { o.costSum += priced; if (own == null) o.costEstimated = true; }
    }
    if (r.est) { try { const e = (JSON.parse(r.est) as { estimate?: Estimate } & Partial<Estimate>); const t = e.estimate?.tokens ?? e.tokens; if (t) { const lo = weighted(t.low), hi = weighted(t.high); o.withEstimate++; o.lowSum += lo; o.highSum += hi; if (actual >= lo && actual <= hi) o.withinRange++; } } catch { /* ignore a malformed estimate */ } }
    g.set(key, o);
  }
  return [...g.values()].map(({ lowSum, highSum, actualSum, costSum, settled, unpriced, ...o }) => ({ ...o, costUsd: settled > 0 && unpriced === 0 ? costSum / settled : null, costEstimated: o.costEstimated && unpriced === 0, actualMw: o.runs - o.contextStops > 0 ? actualSum / (o.runs - o.contextStops) : 0, estLowMw: o.withEstimate ? lowSum / o.withEstimate : null, estHighMw: o.withEstimate ? highSum / o.withEstimate : null })).sort((a, b) => b.runs - a.runs);
}
