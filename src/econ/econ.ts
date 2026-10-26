import type { Db } from '../history/store.ts';

// ---------- prices (USD per 1M tokens) ----------
export interface Price { input: number; cacheRead: number; output: number }
/** Claude prices verified 2026-10-22 at platform.claude.com/docs/en/about-claude/pricing. GPT prices are NOT verified: unknown stays unknown, never 0. */
export const PRICES_VERIFIED_AT = '2026-10-22';
const PRICES: Record<string, Price | ((promptTokens: number) => Price)> = {
  'claude-fable-5-1': { input: 10, cacheRead: 0.25, output: 50 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': (p) => (p <= 100_000 ? { input: 0.1, cacheRead: 0.01, output: 0.5 } : { input: 0.5, cacheRead: 0.05, output: 2.5 }),
};
// Bare aliases (what the CLI accepts: `--model sonnet`) mean the current version of that family.
const ALIAS: [RegExp, string][] = [[/^fable$|fable.?5.?1/i, 'claude-fable-5-1'], [/^opus$|opus.?5.?5/i, 'claude-opus-5-5'], [/^sonnet$|sonnet.?5.?5/i, 'claude-sonnet-5-5'], [/^haiku$|haiku.?5.?5/i, 'claude-haiku-5-5']];

export const canonicalModel = (name: string | null | undefined): string | null => (name ? ALIAS.find(([re]) => re.test(name))?.[1] ?? name : null);
export interface Tokens { uncachedIn: number; cachedIn: number; out: number }

/** API-equivalent dollars, or null when the model's price is not known. Cache writes are counted as input (an approximation noted in docs). */
export function costUsd(model: string | null | undefined, t: Tokens): number | null {
  const m = canonicalModel(model);
  const p = m ? PRICES[m] : undefined;
  if (!p) return null;
  const price = typeof p === 'function' ? p(t.uncachedIn + t.cachedIn) : p;
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
/** 0..1 per finished run: a rating from the user wins; without one, "done" is a weak yes and "failed" a no. Limit stops and manual stops say nothing about quality. */
export function runScore(outcome: string | null, rating: number | null): number | null {
  if (rating === 2) return 1; if (rating === 1) return 0.5; if (rating === 0) return 0;
  if (outcome === 'done') return 0.7; if (outcome === 'failed') return 0;
  return null;
}
export function modelStats(db: Db): Record<string, { n: number; score: number }> {
  const rows = db.prepare("SELECT cls, model, outcome, rating FROM run WHERE cls IS NOT NULL AND model IS NOT NULL AND outcome IS NOT NULL").all() as unknown as { cls: string; model: string; outcome: string; rating: number | null }[];
  const out: Record<string, { n: number; score: number }> = {};
  for (const r of rows) {
    const sc = runScore(r.outcome, r.rating); if (sc == null) continue;
    const m = canonicalModel(r.model) ?? r.model;
    const key = `${r.cls}|${/opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : /fable/i.test(m) ? 'fable' : 'gpt'}`;
    const x = out[key] ?? { n: 0, score: 0 }; x.n++; x.score += sc; out[key] = x;
  }
  return out;
}

// ---------- estimate vs actual ----------
export interface OutcomeRow { cls: string; model: string; effort: string; runs: number; done: number; limit: number; failed: number; actualMw: number; estLowMw: number | null; estHighMw: number | null; withinRange: number; withEstimate: number }

/** Finished runs grouped by task class, model and effort: how often they succeed and whether the shown estimate held (weighted Mtok). */
export function outcomes(db: Db): OutcomeRow[] {
  const rows = db.prepare("SELECT cls, model, effort, outcome, tokens_in AS tin, tokens_cached AS tc, tokens_out AS tout, est_json AS est FROM run WHERE outcome IS NOT NULL AND outcome != 'interrupted'").all() as unknown as { cls: string | null; model: string | null; effort: string | null; outcome: string; tin: number | null; tc: number | null; tout: number | null; est: string | null }[];
  const g = new Map<string, OutcomeRow & { lowSum: number; highSum: number; actualSum: number }>();
  for (const r of rows) {
    const key = [r.cls ?? 'unclassified', canonicalModel(r.model) ?? r.model ?? 'unknown', r.effort ?? '-'].join('|');
    const o = g.get(key) ?? { cls: r.cls ?? 'unclassified', model: canonicalModel(r.model) ?? r.model ?? 'unknown', effort: r.effort ?? '-', runs: 0, done: 0, limit: 0, failed: 0, actualMw: 0, estLowMw: null, estHighMw: null, withinRange: 0, withEstimate: 0, lowSum: 0, highSum: 0, actualSum: 0 };
    o.runs++; if (r.outcome === 'done') o.done++; else if (r.outcome === 'limit') o.limit++; else if (r.outcome === 'failed') o.failed++;
    const cached = r.tc ?? 0;
    const actual = weighted({ uncachedIn: Math.max(0, (r.tin ?? 0) - cached), cachedIn: cached, out: r.tout ?? 0 });
    o.actualSum += actual;
    if (r.est) { try { const e = (JSON.parse(r.est) as { estimate?: Estimate } & Partial<Estimate>); const t = e.estimate?.tokens ?? e.tokens; if (t) { const lo = weighted(t.low), hi = weighted(t.high); o.withEstimate++; o.lowSum += lo; o.highSum += hi; if (actual >= lo && actual <= hi) o.withinRange++; } } catch { /* ignore a malformed estimate */ } }
    g.set(key, o);
  }
  return [...g.values()].map(({ lowSum, highSum, actualSum, ...o }) => ({ ...o, actualMw: o.runs ? actualSum / o.runs : 0, estLowMw: o.withEstimate ? lowSum / o.withEstimate : null, estHighMw: o.withEstimate ? highSum / o.withEstimate : null })).sort((a, b) => b.runs - a.runs);
}
