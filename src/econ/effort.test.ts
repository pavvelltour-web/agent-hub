import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../history/store.ts';
import { DEFAULT_PROFILE, costUsd, effortProfile, modelStats } from './econ.ts';
import { advise, ROUTING } from './advisor.ts';
import { EFFORT_PRICE_MULT, MODEL_ID, PRIOR_EFFORT, priceTier, rank, type EffortLevel } from './router.ts';
import type { RunRequest } from '../adapters/types.ts';

// Effort is a routed dimension: the options are (model, effort) pairs.

test('router: with no data the pair is sonnet:high for implement (the user principle), opus:high for plans, haiku:low for summaries; the table is reproduced for every class', () => {
  assert.equal(rank({ cls: 'implement' })[0]!.key, 'sonnet:high');
  assert.equal(rank({ cls: 'plan' })[0]!.key, 'opus:high');
  assert.equal(rank({ cls: 'summary' })[0]!.key, 'haiku:low');
  for (const [cls, row] of Object.entries(ROUTING)) { const c = advise({ cls: cls as never }); assert.deepEqual([c.model, c.effort, c.rule], [row.model, row.effort, `class:${cls}`], `table row for ${cls}`); }
  const o = rank({ cls: 'implement' })[0]!;
  assert.deepEqual([o.family, o.effort, o.model], ['sonnet', 'high', 'claude-sonnet-5-5']);
  const keys = rank({ cls: 'implement' }).map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length, 'one option per pair');
});

test('router: xhigh and max never win for implement or mechanical without data; only the critical ADR floor pins max', () => {
  for (const cls of ['implement', 'mechanical'] as const) {
    const r = rank({ cls });
    assert.ok(r[0]!.effort !== 'xhigh' && r[0]!.effort !== 'max', `${cls}: ${r[0]!.key}`);
    for (const f of ['opus', 'sonnet', 'fable'] as const) { const best = r.find((o) => o.family === f)!; assert.ok(best.effort !== 'xhigh' && best.effort !== 'max', `${cls}: best ${f} pair is ${best.key}`); }
  }
  assert.ok(PRIOR_EFFORT.implement.xhigh! <= PRIOR_EFFORT.implement.high!, 'xhigh adds nothing over high for coding (studies: +1-4 points at 2-4x cost)');
  assert.equal(advise({ cls: 'critical_adr' }).effort, 'max');
  assert.ok(rank({ cls: 'critical_adr' }).filter((o) => o.family === 'opus').every((o) => o.effort === 'max'));
});

test('router: the price of a pair follows the prior multiplier, or that effort\'s measured output tokens once 3 runs exist', () => {
  assert.deepEqual(EFFORT_PRICE_MULT, { low: 0.6, medium: 1, high: 1.6, xhigh: 2.6, max: 3.5 });
  const ref = costUsd(MODEL_ID.fable, DEFAULT_PROFILE.p50)!, p50 = DEFAULT_PROFILE.p50;
  const tier = (m: string, out: number): number => costUsd(m, { ...p50, out })! / ref;
  const price = (r: ReturnType<typeof rank>, k: string): number => r.find((o) => o.key === k)!.price;
  const r0 = rank({ cls: 'implement' });
  assert.ok(Math.abs(price(r0, 'sonnet:high') - tier(MODEL_ID.sonnet, p50.out * 1.6)) < 0.001);
  assert.ok(Math.abs(price(r0, 'sonnet:medium') - tier(MODEL_ID.sonnet, p50.out)) < 0.001);
  assert.equal(r0.find((o) => o.key === 'sonnet:high')!.priceMeasured, false);
  const prof = (n: number, out: number) => ({ ...DEFAULT_PROFILE, n, source: 'history' as const, p50: { ...p50, out } });
  const r3 = rank({ cls: 'implement', effortProfiles: { 'claude:high': prof(3, 90_000) } });
  assert.ok(Math.abs(price(r3, 'sonnet:high') - tier(MODEL_ID.sonnet, 90_000)) < 0.001, 'measured output replaces the multiplier');
  assert.equal(r3.find((o) => o.key === 'sonnet:high')!.priceMeasured, true);
  assert.ok(Math.abs(price(r3, 'opus:high') - tier(MODEL_ID.opus, 90_000)) < 0.001, 'the measurement is per agent and effort, so it prices every Claude model at that effort');
  const r2 = rank({ cls: 'implement', effortProfiles: { 'claude:high': prof(2, 90_000) } });
  assert.ok(Math.abs(price(r2, 'sonnet:high') - tier(MODEL_ID.sonnet, p50.out * 1.6)) < 0.001, 'two runs are an anecdote: the prior multiplier stays');
  assert.equal(priceTier('sonnet', 'high').known, true); assert.equal(priceTier('gpt', 'low').known, false);
});

test('router: measured results for a pair move that pair, not the others; guard rails and limits still hold on pairs', () => {
  assert.notEqual(rank({ cls: 'implement', stats: { 'implement|sonnet|high': { n: 10, score: 2 } } })[0]!.key, 'sonnet:high', 'ten bad runs at sonnet:high demote that pair');
  assert.equal(rank({ cls: 'implement', stats: { 'implement|sonnet|high': { n: 2, score: 0 } } })[0]!.key, 'sonnet:high', 'two runs do not');
  const s = advise({ cls: 'implement', securityBoundary: true });
  assert.deepEqual([s.model, s.rule], ['claude-opus-5-5', 'security-boundary']); assert.equal(s.options?.filter((o) => o.chosen).length, 1);
  const lim = advise({ cls: 'implement', limits: { claude: { usedPercent: 97, reached: false }, codex: { usedPercent: 20, reached: false } } });
  assert.deepEqual([lim.agent, lim.model, lim.effort], ['codex', 'gpt-6.1-sol', 'high']);
  const c = advise({ cls: 'implement' });
  assert.ok(c.options!.every((o) => o.key === `${o.family}:${o.effort}`) && c.options!.some((o) => o.chosen && o.key === 'sonnet:high'));
  assert.equal(new Set(c.options!.map((o) => o.family)).size, c.options!.length, 'the map shows the best effort of each model');
  const lvl: EffortLevel = 'xhigh'; const req: RunRequest = { prompt: 'p', cwd: '.', effort: lvl };   // an econ effort is a valid adapter effort
  assert.equal(req.effort, 'xhigh');
});

test('effortProfile: tokens of finished runs at that effort and agent; under 3 runs it is the default; reviewer runs and other efforts are left out', () => {
  const db = openDb(':memory:');
  const run = (id: string, agent: string, effort: string, out: number, mode: string | null = null): void => {
    db.prepare("INSERT INTO run (id, agent, model, effort, prompt, cwd, started_at, ended_at, outcome, tokens_in, tokens_cached, tokens_out, cls, work_mode) VALUES (?,?,?,?,'p','C:/p','2026-10-14T10:00:00Z','2026-10-14T10:05:00Z','done',?,?,?,'implement',?)").run(id, agent, agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort, 1_000_000, 900_000, out, mode);
  };
  run('a', 'claude', 'high', 10_000); run('b', 'claude', 'high', 30_000);
  assert.equal(effortProfile(db, 'claude', 'high').source, 'default', 'two runs');
  run('c', 'claude', 'high', 20_000); run('d', 'claude', 'low', 1_000); run('e', 'codex', 'high', 99_000); run('g', 'claude', 'high', 500_000, 'gate-reviewer');
  const p = effortProfile(db, 'claude', 'high');
  assert.deepEqual([p.source, p.n, p.p50.out, p.p50.cachedIn, p.p50.uncachedIn], ['history', 3, 20_000, 900_000, 100_000]);
  assert.equal(effortProfile(db, 'claude', 'low').source, 'default'); assert.equal(effortProfile(db, 'claude', 'max').n, 0);
  run('h', 'claude', 'high', 40_000); run('i', 'claude', 'high', 50_000);
  assert.equal(modelStats(db)['implement|sonnet|high']?.n, 5, 'stats are also kept per pair');
  assert.equal(modelStats(db)['implement|sonnet']?.n, 6, 'and per model as before');
});
