import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRIORS_PATH, loadPriors, parsePriors, tagsFor, TAGS, TAG_LEAN } from './priors.ts';
import { advise } from './advisor.ts';
import { rank } from './router.ts';

const shipped = loadPriors(DEFAULT_PRIORS_PATH);
const idx = (r: ReturnType<typeof rank>, k: string): number => r.findIndex((o) => o.key === k);
const q = (r: ReturnType<typeof rank>, k: string): number => r.find((o) => o.key === k)!.quality;

test('shipped priors: every row has a non-empty source, a real ISO date, a known tag and a quality in 0..1 or null; nothing is rejected', () => {
  assert.equal(shipped.rejected, 0, 'the shipped file has no malformed rows');
  assert.ok(shipped.priors.length >= 8);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const r of [...shipped.priors, ...shipped.surcharges]) {
    assert.ok(typeof r.source === 'string' && r.source.trim().length > 3, `source of ${JSON.stringify(r)}`);
    assert.ok(iso.test(r.date) && !Number.isNaN(Date.parse(r.date)), `date ${r.date}`);
  }
  for (const r of shipped.priors) {
    assert.ok(r.tags.length > 0 && r.tags.every((t) => (TAGS as readonly string[]).includes(t)), `tags ${r.tags}`);
    assert.ok(r.quality === null || (r.quality >= 0 && r.quality <= 1), `quality ${r.quality}`);
  }
  const seen = new Set(shipped.priors.flatMap((r) => r.tags));
  for (const t of ['terminal', 'doc-qa', 'computer-use', 'routine-build']) assert.ok(seen.has(t), `a row for ${t}`);
  const s = shipped.surcharges.find((x) => x.model === 'gpt');
  assert.equal(s?.aboveTokens, 272_000, 'the long-prompt threshold comes from the data, not from router code');
});

test('priors loader never throws: garbage, a missing file, bad JSON and a huge file give an empty set; bad rows are dropped one by one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-priors-'));
  try {
    assert.deepEqual(loadPriors(join(dir, 'nope.json')).priors, []);
    const bad = join(dir, 'bad.json'); writeFileSync(bad, '{ not json');
    assert.deepEqual([loadPriors(bad).priors.length, loadPriors(bad).surcharges.length], [0, 0]);
    const huge = join(dir, 'huge.json'); writeFileSync(huge, ' '.repeat(600_000));
    assert.equal(loadPriors(huge).priors.length, 0);
    for (const junk of [null, 42, 'x', [], { priors: 'no' }, { priors: [null, 1, 'a', {}] }]) assert.doesNotThrow(() => parsePriors(junk));
    const mixed = parsePriors({ priors: [
      { model: 'opus', cls: 'implement', tags: ['terminal'], quality: 0.7, source: 'src A', date: '2026-10-24' },
      { model: 'opus', cls: 'implement', tags: ['terminal'], quality: 0.7, source: '', date: '2026-10-24' },            // no source
      { model: 'opus', cls: 'implement', tags: ['terminal'], quality: 0.7, source: 'src X', date: '24.10.2026' },           // not ISO
      { model: 'opus', cls: 'implement', tags: ['terminal'], quality: 7, source: 'src X', date: '2026-10-24' },             // out of range
      { model: 'nobody', cls: 'implement', tags: ['terminal'], quality: 0.7, source: 'src X', date: '2026-10-24' },         // unknown model
      { model: 'opus', cls: 'implement', tags: ['made-up'], quality: 0.7, source: 'src X', date: '2026-10-24' },            // unknown tag
      { model: 'opus', cls: 'implement', tags: [], quality: 0.7, source: 'src X', date: '2026-10-24' },                     // no tag
      { model: 'gpt', cls: 'summary', tags: ['doc-qa'], quality: null, source: 'src B', date: '2026-10-26' },
    ], surcharges: [{ model: 'gpt', aboveTokens: 272000, priceMultiplier: -3, source: 'src S', date: '2026-10-26' }, { model: 'gpt', aboveTokens: 272000, priceMultiplier: null, source: 'src S', date: '2026-10-26' }] });
    assert.deepEqual(mixed.priors.map((r) => r.source), ['src A', 'src B']);
    assert.equal(mixed.rejected, 6 + 1);
    assert.equal(mixed.surcharges.length, 1);
    // a broken priors set changes nothing: the router still answers, as before
    assert.equal(rank({ cls: 'implement', priors: parsePriors('garbage'), tags: ['terminal', 'long-prompt'] })[0]!.key, 'sonnet:high');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('priors: long-prompt (> 272K input) penalizes GPT by its surcharge; with no known size GPT is sorted behind Claude; other tasks are untouched', () => {
  const sized = parsePriors({ surcharges: [{ model: 'gpt', aboveTokens: 272000, priceMultiplier: 2, source: 'test source', date: '2026-10-26' }] });
  const base = rank({ cls: 'implement', priors: sized }), long = rank({ cls: 'implement', priors: sized, tags: ['long-prompt'] });
  const price = (r: typeof base, k: string): number => r.find((o) => o.key === k)!.price;
  assert.ok(Math.abs(price(long, 'gpt:high') - 2 * price(base, 'gpt:high')) < 0.002, 'GPT costs the surcharge multiple');
  assert.equal(price(long, 'sonnet:high'), price(base, 'sonnet:high'), 'Claude is untouched');
  assert.ok(idx(long, 'gpt:high') > idx(base, 'gpt:high'));
  // equal quality (GPT is priced like Sonnet): a dead heat without the tag, a clear loss for GPT with it
  const eq = { 'implement|gpt': { n: 10, score: 8.7 }, 'implement|sonnet': { n: 10, score: 8.6 } };
  const dist = (r: typeof base, k: string): number => r.find((o) => o.key === k)!.distance;
  const tie = rank({ cls: 'implement', priors: sized, stats: eq }), lose = rank({ cls: 'implement', priors: sized, stats: eq, tags: ['long-prompt'] });
  assert.equal(dist(tie, 'gpt:high'), dist(tie, 'sonnet:high'));
  assert.ok(dist(lose, 'gpt:high') > dist(lose, 'sonnet:high') + 0.01);
  // the shipped file knows the threshold but not the multiple: GPT goes behind every Claude option, yet stays available when Claude is out of limit
  const ship = rank({ cls: 'implement', priors: shipped, tags: ['long-prompt'] });
  assert.equal(ship.findIndex((o) => o.agent === 'codex'), ship.filter((o) => o.agent === 'claude').length, 'all Claude options come before the first GPT one');
  assert.equal(advise({ cls: 'implement', priors: shipped, tags: ['long-prompt'], limits: { claude: { usedPercent: 99, reached: false }, codex: { usedPercent: 10, reached: false } } }).agent, 'codex');
  assert.equal(advise({ cls: 'implement', priors: shipped, tags: ['long-prompt'], stats: { 'implement|gpt': { n: 20, score: 19 }, 'implement|sonnet': { n: 20, score: 6 } } }).agent, 'claude', 'a long prompt prefers Claude even when GPT measured better');
  assert.deepEqual(rank({ cls: 'implement', priors: shipped }).map((o) => o.key), rank({ cls: 'implement' }).map((o) => o.key));
  assert.deepEqual(tagsFor(272_000, shipped), []); assert.deepEqual(tagsFor(272_001, shipped), ['long-prompt']);
  assert.equal(advise({ cls: 'implement', priors: shipped, expectedInputTokens: 300_000, limits: { claude: { usedPercent: 99, reached: false } } }).agent, 'codex');
  assert.equal(advise({ cls: 'implement', priors: shipped, expectedInputTokens: 300_000 }).agent, 'claude');
});

test('priors: computer-use prefers Opus, doc-qa prefers Sol at equal quality, terminal compares measured scores, routine-build leans to Sol', () => {
  // computer-use: only Opus has a score (OSWorld), so it gets the small lean and nobody else moves
  const plain = rank({ cls: 'implement', priors: shipped }), cu = rank({ cls: 'implement', priors: shipped, tags: ['computer-use'] });
  assert.ok(Math.abs(q(cu, 'opus:high') - q(plain, 'opus:high') - TAG_LEAN) < 0.002);
  for (const k of ['sonnet:high', 'gpt:high', 'haiku:high']) assert.equal(q(cu, k), q(plain, k), `${k} unchanged`);
  assert.ok(idx(cu, 'opus:high') <= idx(plain, 'opus:high'));
  const qualityFirst = advise({ cls: 'implement', priors: shipped, tags: ['computer-use'], priceWeight: 0.2 });
  assert.equal(qualityFirst.model, 'claude-opus-5-5'); assert.ok(qualityFirst.basis?.some((b) => b.tag === 'computer-use' && b.source && /^\d{4}-\d{2}-\d{2}$/.test(b.date)), 'the recommendation carries its source and date');
  assert.equal(advise({ cls: 'implement', priors: shipped, priceWeight: 0.2 }).basis, undefined, 'no tag, no basis');
  // doc-qa: same measured quality for Sonnet and GPT (GPT priced like Sonnet): a tie that Claude wins unless the task is document Q&A
  const eq = { 'summary|gpt': { n: 10, score: 9.0 }, 'summary|sonnet': { n: 10, score: 8.85 } };
  assert.ok(idx(rank({ cls: 'summary', priors: shipped, stats: eq }), 'sonnet:low') < idx(rank({ cls: 'summary', priors: shipped, stats: eq }), 'gpt:low'), 'tie goes to Claude');
  const dq = rank({ cls: 'summary', priors: shipped, stats: eq, tags: ['doc-qa'] });
  assert.ok(idx(dq, 'gpt:low') < idx(dq, 'sonnet:low'), 'doc-qa: Sol first at equal quality');
  // terminal: Terminal-Bench scores are compared with each other: GPT (55.1) falls, Sonnet (64.1) and Opus (65.2) rise
  const tm = rank({ cls: 'debug', priors: shipped, tags: ['terminal'] }), pd = rank({ cls: 'debug', priors: shipped });
  assert.ok(q(tm, 'gpt:high') < q(pd, 'gpt:high') && q(tm, 'sonnet:high') > q(pd, 'sonnet:high') && q(tm, 'opus:high') > q(pd, 'opus:high') && q(tm, 'sonnet:high') - q(pd, 'sonnet:high') > 0);
  assert.equal(q(tm, 'haiku:high'), q(pd, 'haiku:high'), 'a model without a score is not guessed');
  // routine-build: Sol is stronger per dollar
  assert.ok(q(rank({ cls: 'mechanical', priors: shipped, tags: ['routine-build'] }), 'gpt:low') > q(rank({ cls: 'mechanical', priors: shipped }), 'gpt:low'));
  // unknown tags do nothing
  assert.deepEqual(rank({ cls: 'implement', priors: shipped, tags: ['whatever'] }).map((o) => o.distance), plain.map((o) => o.distance));
});
