import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costUsd, PRICES_VERIFIED_AT } from './econ.ts';
import { DEFAULT_PRICES_PATH, parsePrices, priceTable, reloadPrices, saveOverride } from './prices.ts';

const home = mkdtempSync(join(tmpdir(), 'hub-prices-'));
after(() => { reloadPrices(); rmSync(home, { recursive: true, force: true }); });
const M = { uncachedIn: 1_000_000, cachedIn: 1_000_000, out: 1_000_000 };

test('bundled prices (registry/prices.json): Claude rows as read from the pricing page, GPT 6.1 Sol priced with its source and date, anything else unknown', () => {
  reloadPrices(home);
  assert.equal(costUsd('claude-sonnet-5-5', M), 2 + 0.1 + 10, 'Sonnet 5.5 cache hit is $0.10 (0.05x of $2): the pricing page footnote; the claude-api skill text that says $0.20 is Sonnet 5');
  assert.equal(costUsd('claude-opus-5-5', M), 4 + 0.2 + 20);
  assert.equal(costUsd('claude-fable-5-1', M), 10 + 0.25 + 50);
  assert.equal(costUsd('gpt-6.1-sol', M), 2 + 0.1 + 10, 'GPT-6.1 Sol $2 / $10, cached $0.10');
  assert.equal(costUsd('gpt-6.1-sol-20261001', M), 12.1, 'a dated name is still Sol');
  assert.equal(costUsd('gpt-6-astra', M), null, 'a model nobody priced stays unknown, never 0');
  assert.equal(costUsd(null, M), null);
  const sol = priceTable().models.get('gpt-6.1-sol')!;
  assert.ok(sol.source.length > 10 && /^\d{4}-\d{2}-\d{2}$/.test(sol.date), 'every row says where it came from and when');
  assert.ok(!/^https?:/.test(sol.url ?? 'x') || sol.url, 'no invented URL');
  assert.match(PRICES_VERIFIED_AT, /^\d{4}-\d{2}-\d{2}$/);
  const small = costUsd('claude-haiku-5-5', { uncachedIn: 50_000, cachedIn: 0, out: 1000 })!, big = costUsd('claude-haiku-5-5', { uncachedIn: 150_000, cachedIn: 0, out: 1000 })!;
  assert.ok(big / 150_000 > small / 50_000, 'Haiku keeps its 100k prompt tier');
});

test('override file in the hub home changes costUsd; an override for an unknown model adds a price; removing it restores the bundled one', () => {
  saveOverride(home, 'claude-sonnet-5-5', { input: 3, cacheRead: 0.3, output: 15 });
  assert.equal(costUsd('claude-sonnet-5-5', M), 3 + 0.3 + 15);
  assert.equal(costUsd('sonnet', M), 18.3, 'the alias follows the override');
  assert.deepEqual([...reloadPrices(home).overridden], ['claude-sonnet-5-5']);
  assert.equal(priceTable().models.get('claude-sonnet-5-5')!.label, 'Claude Sonnet 5.5', 'an override keeps the readable name of the row it replaces');
  saveOverride(home, 'gpt-6-astra', { input: 1, cacheRead: 0.1, output: 5 });
  assert.equal(costUsd('gpt-6-astra', M), 6.1);
  saveOverride(home, 'claude-sonnet-5-5', null); saveOverride(home, 'gpt-6-astra', null);
  assert.equal(costUsd('claude-sonnet-5-5', M), 12.1); assert.equal(costUsd('gpt-6-astra', M), null);
  assert.equal(JSON.parse(readFileSync(join(home, 'prices.json'), 'utf8')).models['claude-sonnet-5-5'], undefined);
});

test('override file: hostile or broken content is dropped row by row (never a crash, never a price of 0 or NaN)', () => {
  const bad = { models: {
    'claude-opus-5-5': { tiers: [{ input: -1, cacheRead: 0, output: 1 }] },
    'claude-haiku-5-5': { tiers: [{ input: 'free', cacheRead: 0, output: 1 }] },
    'constructor': { tiers: [{ input: 1, cacheRead: 1, output: 1 }] },
    'bad name with spaces': { tiers: [{ input: 1, cacheRead: 1, output: 1 }] },
    'x': { tiers: [{ input: 1e9, cacheRead: 1, output: 1 }] },
    'good-model': { tiers: [{ input: 1, cacheRead: 0.1, output: 2 }] },     // a hand-written row may omit source and date
  } };
  // an object literal's __proto__ is not an own key: put it in through JSON text, the way a hand-edited file would
  const json = JSON.stringify(bad).replace('"models":{', '"models":{"__proto__":{"tiers":[{"input":1,"cacheRead":1,"output":1}]},');
  const p = parsePrices(JSON.parse(json), { source: 'вписано вами', date: '2026-10-27' });
  assert.deepEqual([...p.models.keys()], ['good-model']); assert.equal(p.rejected, 6);
  writeFileSync(join(home, 'prices.json'), '{ not json');
  reloadPrices(home);
  assert.equal(costUsd('claude-opus-5-5', M), 24.2, 'a broken file leaves the bundled prices in force');
  writeFileSync(join(home, 'prices.json'), json);
  reloadPrices(home);
  assert.equal(costUsd('claude-opus-5-5', M), 24.2, 'a negative override is ignored');
  assert.equal(costUsd('constructor', M), null); assert.equal(costUsd('toString', M), null);
  assert.throws(() => saveOverride(home, 'bad name', { input: 1, cacheRead: 1, output: 1 }));
  assert.throws(() => saveOverride(home, 'ok-name', { input: -1, cacheRead: 1, output: 1 }));
  assert.throws(() => saveOverride(home, 'ok-name', { input: Number.NaN, cacheRead: 1, output: 1 }));
});

test('prices (review S5a): a price of 0 or below is refused in every column, with the reason per row', () => {
  const zero = parsePrices({ models: {
    free: { tiers: [{ input: 0, cacheRead: 1, output: 1 }] }, 'free-out': { tiers: [{ input: 1, cacheRead: 1, output: 0 }] }, 'free-cache': { tiers: [{ input: 1, cacheRead: 0, output: 1 }] },
    ok: { tiers: [{ input: 1, cacheRead: 0.1, output: 2 }] },
  } }, { source: 's', date: '2026-10-27' });
  assert.deepEqual([...zero.models.keys()], ['ok']); assert.equal(zero.rejected, 3);
  assert.deepEqual(zero.rejectedRows.map((r) => r.id), ['free', 'free-out', 'free-cache']);
  assert.ok(zero.rejectedRows.every((r) => r.reason.length > 5), 'every dropped row says why');
  assert.throws(() => saveOverride(home, 'free', { input: 0, cacheRead: 1, output: 1 }));
  assert.throws(() => saveOverride(home, 'free', { input: 1, cacheRead: 0, output: 1 }));
  writeFileSync(join(home, 'prices.json'), JSON.stringify({ models: { 'claude-opus-5-5': { tiers: [{ input: 0, cacheRead: 0, output: 0 }] } } }));
  const t = reloadPrices(home);
  assert.equal(costUsd('claude-opus-5-5', M), 24.2, 'a $0 override never makes Opus free');
  assert.deepEqual(t.rejectedRows.map((r) => r.id), ['claude-opus-5-5']); assert.equal(t.overridden.size, 0);
  const bundled = parsePrices(JSON.parse(readFileSync(DEFAULT_PRICES_PATH, 'utf8')));
  assert.equal(bundled.rejected, 0, 'the bundled registry has no zero price');
  rmSync(join(home, 'prices.json'));
});

test('prices (review S5d): an unreadable or oversize override file is reported and is never overwritten from an empty start', () => {
  const big = JSON.stringify({ models: { 'a-model': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 'x'.repeat(70_000), date: '2026-10-27' } } });
  writeFileSync(join(home, 'prices.json'), big);
  const t = reloadPrices(home);
  assert.match(t.overrideProblem ?? '', /64/, 'says the file is too big and what the limit is');
  assert.throws(() => saveOverride(home, 'claude-sonnet-5-5', { input: 3, cacheRead: 0.3, output: 15 }), /64/);
  assert.equal(readFileSync(join(home, 'prices.json'), 'utf8'), big, 'the file is untouched');
  writeFileSync(join(home, 'prices.json'), '{ broken');
  assert.match(reloadPrices(home).overrideProblem ?? '', /JSON|прочитать/);
  assert.throws(() => saveOverride(home, 'claude-sonnet-5-5', { input: 3, cacheRead: 0.3, output: 15 }));
  assert.equal(readFileSync(join(home, 'prices.json'), 'utf8'), '{ broken');
  const many = { models: Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`m${i}`, { tiers: [{ input: 1, cacheRead: 1, output: 1 }] }])) };
  writeFileSync(join(home, 'prices.json'), JSON.stringify(many));
  assert.match(reloadPrices(home).overrideProblem ?? '', /200/, 'more than 200 rows: the rest would be ignored, so say so');
  assert.throws(() => saveOverride(home, 'x1', { input: 1, cacheRead: 1, output: 1 }), /200/);
  rmSync(join(home, 'prices.json'));
  assert.equal(reloadPrices(home).overrideProblem, undefined, 'no file is not a problem');
});

test('prices (review S5e): every save writes its own temp file and leaves none behind; two saves in a row both survive', () => {
  rmSync(join(home, 'prices.json'), { force: true });
  saveOverride(home, 'm-a', { input: 1, cacheRead: 0.1, output: 2 }); saveOverride(home, 'm-b', { input: 2, cacheRead: 0.2, output: 4 });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, 'prices.json'), 'utf8')).models).sort(), ['m-a', 'm-b']);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  saveOverride(home, 'm-a', null); saveOverride(home, 'm-b', null);
});

test('prices (review S5b): the router marks an option whose price came from the override file', async () => {
  const { rank, priceTier } = await import('./router.ts');
  rmSync(join(home, 'prices.json'), { force: true }); reloadPrices(home);
  assert.ok(rank({ cls: 'implement' }).every((o) => o.overridden === false));
  saveOverride(home, 'claude-opus-5-5', { input: 1, cacheRead: 0.05, output: 5 });
  assert.deepEqual([...new Set(rank({ cls: 'implement' }).filter((o) => o.overridden).map((o) => o.family))], ['opus']);
  assert.equal(priceTier('opus').overridden, true); assert.equal(priceTier('sonnet').overridden, false);
  saveOverride(home, 'claude-fable-5-1', { input: 8, cacheRead: 0.2, output: 40 });
  assert.ok(rank({ cls: 'implement' }).every((o) => o.overridden), 'Fable is the scale every price is measured against: changing it changes every tier');
  saveOverride(home, 'claude-opus-5-5', null); saveOverride(home, 'claude-fable-5-1', null);
});
