import type { BenchRow } from '../bench/bench.ts';
import { costUsd, type OutcomeRow } from './econ.ts';
import { modelKey, priceTier, rank, type EffortLevel, type ModelKey, type TaskClass } from './router.ts';

/**
 * "What does one SOLVED task cost?" under four ways of choosing a model, from the user's own data (bench rows or finished runs).
 * - always-max: the most expensive (model, effort) pair that appears in the data, every time.
 * - manual:     what was actually run (only history says anything: a bench is not the user's own choosing).
 * - router:     the pair the router would pick for the task's class, taken from the runs that really used that pair.
 * - cheap-first: the cheapest pair first, the next one up only when it failed (the cascade); built from separate runs, so a simulation.
 * `label` is 'measured' only when every number comes straight from runs of that strategy; a price filled in from tokens, a limit share computed from
 * a calibration, or a cascade assembled from separate runs make it 'estimated'. Unknown stays null, never 0.
 */
export type StrategyName = 'always-max' | 'manual' | 'cheap-first' | 'router';
export interface StrategyResult { strategy: StrategyName; costPerSolved: number | null; limitPctPerSolved: number | null; n: number; label: 'measured' | 'estimated' }
export interface StrategyOpts {
  /** Task class of a bench task (bench rows carry only the task id). */
  clsOf?: (taskId: string) => string | undefined;
  /** The router's pick for a class, `model:effort` (default: the first option of `rank`). */
  routerPick?: (cls: string) => string | undefined;
  /** Weighted Mtok per 1% of the weekly limit for a model, or null when not measured (history rows only: bench rows carry their own limit %). */
  mwPerPct?: (model: string) => number | null;
}

/** One (group, pair): the attempts behind it and their totals. `cost`/`pct` are totals over `attempts`, null when any attempt lacks one. */
interface Cell { group: string; cls: string | undefined; key: string; attempts: number; solved: number; cost: number | null; pct: number | null; costFilledIn: boolean; pctComputed: boolean }

const CLASSES = new Set<string>(['plan', 'critical_adr', 'implement', 'debug', 'review', 'mechanical', 'summary']);
const NAMES: StrategyName[] = ['always-max', 'manual', 'cheap-first', 'router'];
const keyOf = (model: string, effort: string): string => `${modelKey(model)}:${effort.toLowerCase()}`;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const isBench = (r: BenchRow | OutcomeRow): r is BenchRow => 'taskId' in r;
/** Cheapness order of a pair, from the price table (the same tiers the router uses). */
const tierOf = (key: string): number => { const [k, e] = key.split(':') as [ModelKey, EffortLevel]; return priceTier(k, e).tier; };

function fromBench(rows: BenchRow[], o: StrategyOpts): Cell[] {
  const g = new Map<string, Cell>();
  for (const r of rows) {
    const key = keyOf(r.model, r.effort), id = `${r.taskId}|${key}`;
    const c = g.get(id) ?? { group: r.taskId, cls: o.clsOf?.(r.taskId), key, attempts: 0, solved: 0, cost: 0, pct: 0, costFilledIn: false, pctComputed: false };
    c.attempts++; if (r.solved) c.solved++;
    const own = r.costUsd, filled = own ?? costUsd(r.model, r.tokens);
    c.cost = c.cost == null || filled == null ? null : c.cost + filled;
    if (own == null && filled != null) c.costFilledIn = true;
    c.pct = c.pct == null || r.limitPct == null ? null : c.pct + r.limitPct;
    g.set(id, c);
  }
  return [...g.values()];
}

function fromOutcomes(rows: OutcomeRow[], o: StrategyOpts): Cell[] {
  const out: Cell[] = [];
  for (const r of rows) {
    const attempts = r.done + r.failed;       // a limit stop or a branch still in review says nothing about the pick
    if (attempts === 0) continue;
    const mw = o.mwPerPct?.(r.model) ?? null, perRun = mw && mw > 0 ? r.actualMw / mw : null;
    out.push({ group: r.cls, cls: r.cls, key: keyOf(r.model, r.effort), attempts, solved: r.done, cost: r.costUsd == null ? null : r.costUsd * attempts, pct: perRun == null ? null : perRun * attempts, costFilledIn: r.costEstimated, pctComputed: perRun != null });
  }
  return out;
}

/** Cost and limit share per solved task of a set of cells that really ran; null when nothing was solved or any number is missing. */
function measured(strategy: StrategyName, cells: Cell[]): StrategyResult {
  const solved = cells.reduce((s, c) => s + c.solved, 0);
  const sum = (f: (c: Cell) => number | null): number | null => { let t = 0; for (const c of cells) { const v = f(c); if (v == null) return null; t += v; } return t; };
  const cost = sum((c) => c.cost), pct = sum((c) => c.pct);
  const estimated = (cost != null && cells.some((c) => c.costFilledIn)) || (pct != null && cells.some((c) => c.pctComputed));
  return { strategy, costPerSolved: cells.length && solved > 0 && cost != null ? r6(cost / solved) : null, limitPctPerSolved: cells.length && solved > 0 && pct != null ? r6(pct / solved) : null, n: cells.reduce((s, c) => s + c.attempts, 0), label: estimated ? 'estimated' : 'measured' };
}

/** Cascade per group: the cheapest pair, then the next only if it failed. Expected cost and expected solves, from each pair's own success rate and mean cost. */
function cascade(groups: Map<string, Cell[]>): StrategyResult {
  let cost: number | null = 0, pct: number | null = 0, solved = 0, n = 0, counterfactual = false;
  for (const cells of groups.values()) {
    const ladder = [...cells].sort((a, b) => tierOf(a.key) - tierOf(b.key) || a.key.localeCompare(b.key));
    if (ladder.length > 1) counterfactual = true;
    let reach = 1;     // chance the task is still unsolved when it gets to the rung
    for (const c of ladder) {
      const p = c.solved / c.attempts;
      cost = cost == null || c.cost == null ? null : cost + reach * (c.cost / c.attempts);
      pct = pct == null || c.pct == null ? null : pct + reach * (c.pct / c.attempts);
      solved += reach * p; reach *= 1 - p; n += c.attempts;
      if (c.costFilledIn || c.pctComputed) counterfactual = true;
    }
  }
  return { strategy: 'cheap-first', costPerSolved: groups.size && solved > 0 && cost != null ? r6(cost / solved) : null, limitPctPerSolved: groups.size && solved > 0 && pct != null ? r6(pct / solved) : null, n, label: counterfactual ? 'estimated' : 'measured' };
}

export function compareStrategies(rows: BenchRow[] | OutcomeRow[], opts: StrategyOpts = {}): StrategyResult[] {
  const all = rows as (BenchRow | OutcomeRow)[];
  const bench = all.length > 0 && isBench(all[0] as BenchRow | OutcomeRow);
  const cells = bench ? fromBench(all as BenchRow[], opts) : fromOutcomes(all as OutcomeRow[], opts);
  const groups = new Map<string, Cell[]>();
  for (const c of cells) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);

  // always-max: the dearest pair seen anywhere, wherever it ran
  const maxKey = [...new Set(cells.map((c) => c.key))].sort((a, b) => tierOf(b) - tierOf(a) || b.localeCompare(a))[0];
  const alwaysMax = measured('always-max', cells.filter((c) => c.key === maxKey));
  // manual: history only, every run as it happened
  const manual = bench ? measured('manual', []) : measured('manual', cells);
  // router: per group, the pair the router picks (when it has runs)
  const pick = opts.routerPick ?? ((cls: string): string | undefined => (CLASSES.has(cls) ? rank({ cls: cls as TaskClass })[0]?.key : undefined));   // 'unclassified' has no router pick
  const routed: Cell[] = [];
  for (const [, cs] of groups) {
    const cls = cs[0]?.cls, want = cls ? pick(cls) : undefined;
    const cell = want ? cs.find((c) => c.key === want) : undefined;
    if (cell) routed.push(cell);
  }
  const results: Record<StrategyName, StrategyResult> = { 'always-max': alwaysMax, manual, 'cheap-first': cascade(groups), router: measured('router', routed) };
  return NAMES.map((n) => results[n]);
}
