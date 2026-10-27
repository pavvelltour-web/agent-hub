import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BenchRow } from '../bench/bench.ts';
import type { OutcomeRow } from './econ.ts';
import { compareStrategies } from './strategies.ts';

const tok = { uncachedIn: 1000, cachedIn: 0, out: 100 };
const bench = (taskId: string, model: string, effort: string, solved: boolean, costUsd: number | null, limitPct: number | null = null): BenchRow =>
  ({ taskId, agent: 'claude', model, effort, solved, tokens: tok, costUsd, limitPct, seconds: 1 });
const by = (r: ReturnType<typeof compareStrategies>, s: string) => r.find((x) => x.strategy === s)!;

const S = 'claude-sonnet-5-5', O = 'claude-opus-5-5';
const rows: BenchRow[] = [
  bench('t1', S, 'high', true, 0.2), bench('t1', O, 'high', true, 1), bench('t1', O, 'max', true, 2),
  bench('t2', S, 'high', false, 0.2), bench('t2', O, 'high', true, 1), bench('t2', O, 'max', true, 2.2),
];
const clsOf = (): string => 'implement';

test('strategies on bench rows: always-max and router are read off real runs, cheap-first is a simulation and says "estimated"', () => {
  const r = compareStrategies(rows, { clsOf, routerPick: () => 'opus:high' });
  assert.deepEqual(r.map((x) => x.strategy), ['always-max', 'manual', 'cheap-first', 'router']);
  assert.deepEqual([by(r, 'always-max').costPerSolved, by(r, 'always-max').n, by(r, 'always-max').label], [2.1, 2, 'measured']);
  assert.deepEqual([by(r, 'router').costPerSolved, by(r, 'router').n, by(r, 'router').label], [1, 2, 'measured']);
  // cheap-first: t1 solved at the cheap rung (0.2); t2 pays the cheap rung then the next (0.2 + 1): 1.4 for 2 solved
  assert.deepEqual([by(r, 'cheap-first').costPerSolved, by(r, 'cheap-first').label], [0.7, 'estimated']);
  // a bench is not the user's own picking: nothing to say about "manual"
  assert.deepEqual([by(r, 'manual').costPerSolved, by(r, 'manual').n], [null, 0]);
});

test('strategies: a missing price stays unknown, a price filled in from tokens is "estimated", a limit % is null unless every run has one', () => {
  const unknown = compareStrategies([bench('t1', 'mystery-9', 'high', true, null)], { clsOf, routerPick: () => 'gpt:high' });
  assert.equal(by(unknown, 'router').costPerSolved, null, 'unknown price is never 0');
  const filled = compareStrategies([bench('t1', S, 'high', true, null)], { clsOf, routerPick: () => 'sonnet:high' });
  assert.ok((by(filled, 'router').costPerSolved ?? 0) > 0);
  assert.equal(by(filled, 'router').label, 'estimated', 'the number comes from the price table, not from the run');
  const pct = compareStrategies([bench('t1', S, 'high', true, 0.2, 4), bench('t2', S, 'high', true, 0.2, 6)], { clsOf, routerPick: () => 'sonnet:high' });
  assert.equal(by(pct, 'router').limitPctPerSolved, 5);
  const partial = compareStrategies([bench('t1', S, 'high', true, 0.2, 4), bench('t2', S, 'high', true, 0.2, null)], { clsOf, routerPick: () => 'sonnet:high' });
  assert.equal(by(partial, 'router').limitPctPerSolved, null);
  assert.deepEqual(compareStrategies([]).map((x) => [x.costPerSolved, x.n]), [[null, 0], [null, 0], [null, 0], [null, 0]]);
});

const out = (model: string, effort: string, p: Partial<OutcomeRow>): OutcomeRow =>
  ({ cls: 'implement', model, effort, runs: 0, done: 0, limit: 0, failed: 0, pending: 0, actualMw: 1, estLowMw: null, estHighMw: null, withinRange: 0, withEstimate: 0, costUsd: null, costEstimated: false, ...p });

test('strategies on history rows: manual = what the user actually ran; limit stops and pending branches are not attempts; limit % needs a measured calibration', () => {
  const hist: OutcomeRow[] = [
    out(S, 'high', { runs: 6, done: 3, failed: 1, limit: 1, pending: 1, costUsd: 0.5, actualMw: 1 }),
    out(O, 'max', { runs: 2, done: 2, costUsd: 3, actualMw: 2 }),
  ];
  const r = compareStrategies(hist);
  assert.deepEqual([by(r, 'manual').costPerSolved, by(r, 'manual').n, by(r, 'manual').label], [1.6, 6, 'measured']);   // (4*0.5 + 2*3) / 5 solved
  assert.deepEqual([by(r, 'always-max').costPerSolved, by(r, 'always-max').n], [3, 2]);
  assert.equal(by(r, 'router').costPerSolved, 0.666667, 'the router would pick sonnet:high for implement, and the user has runs there');
  assert.equal(by(r, 'router').limitPctPerSolved, null, 'no calibration: the limit share is unknown, not 0');
  assert.deepEqual([by(r, 'cheap-first').costPerSolved, by(r, 'cheap-first').label], [1.25, 'estimated']);
  const withUnclassified = compareStrategies([...hist, out(S, 'high', { cls: 'unclassified', runs: 1, done: 1, costUsd: 0.1 })]);
  assert.equal(by(withUnclassified, 'router').costPerSolved, 0.666667, 'runs without a task type have no router pick and are left out of it (no crash)');
  assert.equal(by(withUnclassified, 'manual').n, 7);
  const withCal = compareStrategies(hist, { mwPerPct: () => 2 });
  assert.equal(by(withCal, 'router').limitPctPerSolved, 0.666667);
  assert.equal(by(withCal, 'router').label, 'estimated', 'a limit share computed from a calibration is not a measurement');
});
