import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The trace page's data layer is DOM-free (plain web JS), so the hostile-data rules are checked in node.
const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'trace-model.js')).href) as { traceModel: (r: unknown) => any; plain: (s: unknown, n?: number) => string; msText: (n: unknown) => string; lanes: (turns: any[]) => any[]; mergePage: (m: any, next: any) => any };

const good = { run: { id: 'rab12', agent: 'claude', model: 'claude-sonnet-5-5', effort: 'high', outcome: 'done' }, total: 2, next: null, truncated: false,
  totals: { newIn: 40, cachedIn: 3300, out: 90, reasoning: 0, ms: 960, costUsd: 0.05 }, slowest: [{ name: 'Bash', ms: 290, turn: 1 }],
  turns: [
    { n: 1, startedAt: '2026-10-27T10:00:00.100Z', ms: 400, model: 'claude-sonnet-5-5', tokens: { newIn: 15, cachedIn: 900, out: 40, reasoning: 0 }, context: 915, cacheHit: 0.98, tools: [{ name: 'Bash', ms: 290, ok: false, bytes: 4 }, { name: 'Read', ms: 39, ok: true, bytes: 200 }], costUsd: 0.001 },
    { n: 2, startedAt: '2026-10-27T10:00:00.500Z', ms: 460, model: 'claude-sonnet-5-5', tokens: { newIn: 25, cachedIn: 2400, out: 50, reasoning: 0 }, context: 1305, cacheHit: 0.99, tools: [], costUsd: null },
  ] };

test('traceModel: turns, totals and the slowest steps are read by type; money unknown stays unknown', () => {
  const m = M.traceModel(good);
  assert.equal(m.turns.length, 2); assert.equal(m.run.id, 'rab12'); assert.equal(m.totals.costUsd, 0.05);
  assert.equal(m.turns[1].costUsd, null, 'an unknown price is null, never 0');
  assert.deepEqual(m.turns[0].tools.map((t: any) => [t.name, t.ok]), [['Bash', false], ['Read', true]]);
  assert.equal(m.slowest[0].name, 'Bash'); assert.equal(m.next, null);
  assert.equal(M.traceModel(null), null); assert.equal(M.traceModel({}), null); assert.equal(M.traceModel({ turns: 'x' }), null);
});

test('traceModel: hostile or malformed data never throws and is never stringified; names are shown with invisible characters made visible', () => {
  const m = M.traceModel({ run: { id: '../x', agent: { a: 1 }, model: ['m'], outcome: '__proto__' }, turns: [null, 5, { n: 'x', ms: -3, model: { toString: 1 }, tokens: { newIn: 'many', out: NaN }, context: Infinity, cacheHit: 7, tools: [null, { name: '<img src=x onerror=1>‮gnp.exe​', ms: 'x', bytes: -1 }, { name: 'a'.repeat(5000) }], costUsd: 'free' }], totals: { newIn: 'x' }, slowest: [{ name: { a: 1 }, ms: 'x' }, 7] });
  assert.equal(m.run.id, ''); assert.equal(m.run.agent, ''); assert.equal(m.run.model, '');
  assert.equal(m.turns.length, 1); const t = m.turns[0];
  assert.equal(t.n, 1, 'a missing number falls back to the position'); assert.equal(t.ms, 0); assert.equal(t.model, ''); assert.equal(t.tokens.newIn, 0); assert.equal(t.context, 0); assert.ok(t.cacheHit >= 0 && t.cacheHit <= 1);
  assert.equal(t.costUsd, null);
  assert.equal(t.tools.length, 2, 'a non-object tool is dropped');
  const name: string = t.tools[0].name;
  assert.ok(name.includes('<img src=x onerror=1>'), 'markup stays text');
  assert.ok(name.includes('\\u202e') && name.includes('\\u200b'), 'bidi and zero-width characters become visible escapes');
  assert.ok(!name.includes('‮') && !name.includes('​'), 'and the real characters are gone');
  assert.ok(t.tools[1].name.length <= 100);
  assert.equal(m.totals.newIn, 0); assert.equal(m.slowest.length, 1); assert.equal(m.slowest[0].name, 'unknown');
});

test('plain / msText: control characters are visible, durations are plain Russian', () => {
  assert.equal(M.plain('a\nb\tc\u0000'), 'a\\u000ab\\u0009c\\u0000'); assert.equal(M.plain({}), ''); assert.equal(M.plain('x'.repeat(300), 10).length, 10);
  assert.equal(M.msText(0), '0 мс'); assert.equal(M.msText(290), '290 мс'); assert.equal(M.msText(1500), '1,5 с'); assert.equal(M.msText(125000), '2 мин 5 с'); assert.equal(M.msText('x'), '0 мс'); assert.equal(M.msText(-1), '0 мс');
});

test('lanes: the timeline gives every turn a share of the bar by its time and splits it into tool time and the rest; nothing is wider than the whole', () => {
  const m = M.traceModel(good); const l = M.lanes(m.turns);
  assert.equal(l.length, 2); assert.ok(l[0].flex > 0 && l[1].flex > 0);
  const t0 = l[0]; assert.deepEqual(t0.parts.map((p: any) => p.kind), ['tool', 'tool', 'rest']); assert.ok(t0.parts.every((p: any) => p.flex >= 0));
  assert.ok(t0.parts.reduce((a: number, p: any) => a + p.flex, 0) <= t0.flex + 1e-9, 'tool time is clamped to the turn time (parallel tools overlap)');
  const par = M.lanes([{ n: 1, ms: 100, tools: [{ name: 'a', ms: 100 }, { name: 'b', ms: 100 }] }])[0];
  assert.ok(par.parts.reduce((a: number, p: any) => a + p.flex, 0) <= 100 + 1e-9, 'two parallel 100 ms tools in a 100 ms turn do not make it 200');
  assert.deepEqual(M.lanes([]), []);
  const zero = M.lanes([{ n: 1, ms: 0, tools: [] }, { n: 2, ms: 0, tools: [] }]); assert.ok(zero.every((x: any) => x.flex > 0), 'a turn with no measured time is still drawn');
});

test('mergePage: a second page is appended in order, totals come from the newest answer, duplicates are dropped', () => {
  const a = M.traceModel({ ...good, turns: [good.turns[0]], next: 1, total: 2 }), b = M.traceModel({ ...good, turns: [good.turns[1]], next: null });
  const m = M.mergePage(a, b);
  assert.deepEqual(m.turns.map((t: any) => t.n), [1, 2]); assert.equal(m.next, null);
  assert.deepEqual(M.mergePage(m, b).turns.map((t: any) => t.n), [1, 2], 'a repeated page changes nothing');
});

const L = await import(pathToFileURL(join(web, 'log-model.js')).href) as { filterOptions: (r: any[]) => any; matches: (r: any, f: any) => boolean; kindLabel: (s: unknown) => string };
test('journal filters: options come from the rows, a row without the attribute is hidden under that filter, hostile rows never throw', () => {
  const rows = [
    { source: 'end', agent: 'claude', model: 'claude-sonnet-5-5', projectId: 1, runId: 'r1' }, { source: 'error', agent: 'codex', model: 'gpt-6.1-sol', projectId: 2 },
    { source: 'audit' }, null, 5, { source: { a: 1 }, agent: 'evil', model: ['x'], projectId: '1' },
  ];
  const o = L.filterOptions(rows);
  assert.deepEqual(o.projects, ['1', '2']); assert.deepEqual(o.agents, ['claude', 'codex']); assert.deepEqual(o.models, ['claude-sonnet-5-5', 'gpt-6.1-sol']); assert.deepEqual(o.kinds, ['audit', 'end', 'error']);
  const f = (x: object) => rows.filter((r) => L.matches(r, { project: '', agent: '', model: '', kind: '', ...x })).length;
  assert.equal(f({}), 4, 'null and non-objects are never shown');
  assert.equal(f({ project: '1' }), 1); assert.equal(f({ agent: 'codex' }), 1); assert.equal(f({ model: 'claude-sonnet-5-5' }), 1); assert.equal(f({ kind: 'audit' }), 1);
  assert.equal(f({ project: '1', agent: 'codex' }), 0, 'filters combine');
  assert.equal(L.kindLabel('end'), 'Завершение'); assert.equal(L.kindLabel('__proto__'), 'Другое'); assert.equal(L.kindLabel({}), 'Другое');
});
