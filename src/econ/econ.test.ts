import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, addLimit, addUsage, upsertSession } from '../history/store.ts';
import { DEFAULT_PROFILE, calibrate, canonicalModel, costUsd, estimate, profileFromHistory, weighted } from './econ.ts';
import { advise } from './advisor.ts';

test('costUsd: verified Claude prices; unknown model is null, never 0; Haiku has a 100k prompt tier', () => {
  const t = { uncachedIn: 150_000, cachedIn: 4_780_000, out: 20_000 };
  assert.equal(Math.round(costUsd('claude-sonnet-5-5-20261001', t)! * 100) / 100, 0.98);
  assert.equal(Math.round(costUsd('claude-opus-5-5', t)! * 100) / 100, 1.96);
  assert.equal(costUsd('gpt-6.1-sol', t), null);
  assert.equal(costUsd(null, t), null);
  const small = costUsd('haiku-5.5', { uncachedIn: 50_000, cachedIn: 0, out: 1000 })!, big = costUsd('claude-haiku-5-5', { uncachedIn: 150_000, cachedIn: 0, out: 1000 })!;
  assert.ok(big / 150_000 > small / 50_000, 'over-100k prompt is billed at the higher tier');
  assert.equal(canonicalModel('Claude Sonnet 5.5'), 'claude-sonnet-5-5');
});

test('estimate is a range with confidence and honest notes', () => {
  const e = estimate(DEFAULT_PROFILE, 'claude-opus-5-5', { lowMwPerPct: 1, highMwPerPct: 8, n: 0, source: 'prior' });
  assert.ok(e.usd!.low < e.usd!.high && e.percent!.low < e.percent!.high);
  assert.equal(e.confidence, 'low');
  assert.ok(e.notes.some((n) => /грубая прикидка/.test(n)) && e.notes.some((n) => /средних значений/.test(n)));
  const unk = estimate(DEFAULT_PROFILE, 'gpt-6.1-sol', { lowMwPerPct: 0, highMwPerPct: 0, n: 0, source: 'none' });
  assert.equal(unk.usd, null); assert.equal(unk.percent, null);
  assert.ok(unk.notes.some((n) => /доллары не считаются/.test(n)));
  assert.ok(Math.abs(weighted({ uncachedIn: 1e6, cachedIn: 10e6, out: 0.2e6 }) - 3) < 1e-9, 'u + 0.1c + 5o');
});

test('profile uses history when ≥10 sessions, default otherwise', () => {
  const db = openDb(':memory:');
  assert.equal(profileFromHistory(db).source, 'default');
  for (let i = 0; i < 12; i++) {
    upsertSession(db, { id: `codex:s${i}`, agent: 'codex', nativeId: `s${i}`, sourceKind: 'x', sourcePath: 'p' });
    addUsage(db, `codex:s${i}`, '2026-10-01T00:00:00Z', 'gpt-6.1-sol', { uncachedIn: 100 * (i + 1), cachedIn: 1000 * (i + 1), out: 10 * (i + 1) });
    db.prepare('UPDATE session SET msg_count = 9 WHERE id = ?').run(`codex:s${i}`);
  }
  const p = profileFromHistory(db, 'codex');
  assert.equal(p.source, 'history'); assert.equal(p.n, 12); assert.ok(p.p50.uncachedIn >= 600 && p.p90.uncachedIn > p.p50.uncachedIn);
});

test('calibrate: prior for Codex, none for Claude; becomes measured with ≥5 intervals', () => {
  const db = openDb(':memory:');
  assert.equal(calibrate(db, 'claude').source, 'none');
  assert.equal(calibrate(db, 'codex').source, 'prior');
  upsertSession(db, { id: 'codex:a', agent: 'codex', nativeId: 'a', sourceKind: 'x', sourcePath: 'p' });
  let pctNow = 10;
  for (let i = 0; i < 7; i++) {
    const ts = `2026-10-0${i + 1}T10:00:00Z`;
    addLimit(db, { agent: 'codex', ts, windowMinutes: 10080, usedPercent: pctNow, resetsAt: 111, planType: 'prolite', source: 'codex-log' });
    addUsage(db, 'codex:a', `2026-10-0${i + 1}T11:00:00Z`, 'm', { uncachedIn: 2_000_000, cachedIn: 0, out: 0 });
    pctNow += 4;
  }
  addLimit(db, { agent: 'codex', ts: '2026-10-08T10:00:00Z', windowMinutes: 10080, usedPercent: pctNow, resetsAt: 111, planType: 'prolite', source: 'codex-log' });
  const c = calibrate(db, 'codex');
  assert.equal(c.source, 'measured'); assert.ok(c.n >= 5);
  assert.ok(Math.abs(c.lowMwPerPct - 0.5) < 0.01, `2 Mtok / 4% = 0.5 Mw/% (got ${c.lowMwPerPct})`);
});

test('advise: table, escalation ladder, security boundary, limit-aware switch, both limited', () => {
  assert.deepEqual(pick(advise({ cls: 'implement' })), ['claude', 'claude-sonnet-5-5', 'medium', 'class:implement']);
  assert.deepEqual(pick(advise({ cls: 'plan' })), ['claude', 'claude-opus-5-5', 'high', 'class:plan']);
  assert.equal(advise({ cls: 'critical_adr' }).effort, 'max');
  assert.deepEqual(pick(advise({ cls: 'implement', failures: 2 })), ['claude', 'claude-sonnet-5-5', 'high', 'ladder:sonnet-high']);
  assert.deepEqual(pick(advise({ cls: 'implement', failures: 3 })), ['claude', 'claude-opus-5-5', 'high', 'ladder:opus']);
  assert.equal(advise({ cls: 'implement', securityBoundary: true }).rule, 'security-boundary');
  const c = advise({ cls: 'implement', limits: { claude: { usedPercent: 97, reached: false }, codex: { usedPercent: 20, reached: false } } });
  assert.deepEqual(pick(c), ['codex', 'gpt-6.1-sol', 'medium', 'limit:claude→codex']);
  assert.equal(advise({ cls: 'implement', limits: { claude: { usedPercent: null, reached: true }, codex: { usedPercent: 99, reached: false } } }).rule, 'limit:both');
  assert.equal(advise({ cls: 'implement', limits: { claude: { usedPercent: 50, reached: false } } }).agent, 'claude');
});
const pick = (c: ReturnType<typeof advise>): string[] => [c.agent, c.model, c.effort, c.rule];

test('advise: GPT is a real option, not only a fallback: cross-review, spreading load, and an alternative on the other vendor every time', () => {
  const r1 = advise({ cls: 'review', implementedBy: 'claude' });
  assert.deepEqual([r1.agent, r1.rule], ['codex', 'cross-review']);
  const r2 = advise({ cls: 'review', implementedBy: 'codex' });
  assert.deepEqual([r2.agent, r2.model, r2.rule], ['claude', 'claude-opus-5-5', 'cross-review']);
  const b = advise({ cls: 'implement', limits: { claude: { usedPercent: 75, reached: false }, codex: { usedPercent: 10, reached: false } } });
  assert.deepEqual([b.agent, b.rule], ['codex', 'balance']); assert.equal(b.alt?.agent, 'claude');
  assert.equal(advise({ cls: 'implement', limits: { claude: { usedPercent: 75, reached: false }, codex: { usedPercent: 60, reached: false } } }).agent, 'claude', 'no spreading when Codex has no clear advantage');
  assert.equal(advise({ cls: 'plan', limits: { claude: { usedPercent: 75, reached: false }, codex: { usedPercent: 10, reached: false } } }).agent, 'claude', 'plans stay on the strongest model');
  const d = advise({ cls: 'implement' });
  assert.equal(d.alt?.agent, 'codex'); assert.match(d.reason, /[а-я]/, 'reasons are written in Russian for the panel');
  assert.equal(advise({ cls: 'review', implementedBy: 'claude', limits: { codex: { usedPercent: 99, reached: false } } }).agent, 'claude', 'cross-review falls back to Claude when Codex is out');
});

test('router: with no data the optimizer reproduces the author table; real results move the choice; price weight and exploration are explicit', async () => {
  const { rank, priceTier, modelKey } = await import('./router.ts');
  const { ROUTING } = await import('./advisor.ts');
  for (const [cls, row] of Object.entries(ROUTING)) { const c = advise({ cls: cls as never }); assert.equal(c.model, row.model, `default for ${cls}`); assert.equal(c.agent, 'claude'); }
  assert.equal(priceTier('gpt').known, false); assert.equal(priceTier('opus').known, true);
  assert.ok(priceTier('haiku').tier < priceTier('sonnet').tier && priceTier('sonnet').tier < priceTier('opus').tier && priceTier('opus').tier < priceTier('fable').tier);
  // 20 runs where GPT solved implementation tasks and Sonnet mostly failed: the choice moves to GPT and says it is measured
  const stats = { 'implement|gpt': { n: 20, score: 19 }, 'implement|sonnet': { n: 20, score: 8 } };
  const learned = advise({ cls: 'implement', stats });
  assert.equal(learned.agent, 'codex'); assert.match(learned.reason, /вашим запускам/); assert.equal(learned.rule, 'optimizer');
  // the other way round
  assert.equal(advise({ cls: 'implement', stats: { 'implement|sonnet': { n: 20, score: 19 }, 'implement|gpt': { n: 20, score: 6 } } }).model, 'claude-sonnet-5-5');
  // few runs barely move a prior
  assert.equal(advise({ cls: 'implement', stats: { 'implement|gpt': { n: 2, score: 2 } } }).agent, 'claude');
  // quality-first vs price-first
  assert.notEqual(advise({ cls: 'implement', priceWeight: 0.1 }).model, advise({ cls: 'implement', priceWeight: 3 }).model);
  assert.equal(advise({ cls: 'implement', priceWeight: 5 }).model, 'claude-haiku-5-5');
  // exploration only on simple tasks, never when security is involved, and only when asked
  assert.equal(advise({ cls: 'plan', explore: 1, rand: () => 0 }).rule, 'class:plan');
  assert.equal(advise({ cls: 'mechanical', explore: 0, rand: () => 0 }).rule, 'class:mechanical');
  const ex = advise({ cls: 'mechanical', explore: 0.3, rand: () => 0 });
  assert.equal(ex.rule, 'explore'); assert.notEqual(ex.model, 'claude-sonnet-5-5');
  assert.equal(advise({ cls: 'mechanical', explore: 0.3, rand: () => 0, securityBoundary: true }).rule, 'security-boundary');
  // the map: top options with the chosen one marked, sorted by distance to the ideal
  const c = advise({ cls: 'implement' });
  assert.equal(c.options?.filter((o) => o.chosen).length, 1); assert.deepEqual(c.options?.map((o) => o.distance), [...(c.options ?? [])].map((o) => o.distance).sort((a, b) => a - b));
  assert.equal(modelKey('gpt-6.1-sol'), 'gpt'); assert.equal(rank({ cls: 'plan' })[0]!.key, 'opus');
});
