import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forecast, parseTasks, MIN_SETTLED, MIN_CLASS_SAMPLES, type ForecastIn, type RunSample } from './forecast.ts';
import type { OutcomeRow } from './econ.ts';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const { forecastModel, forecastLine } = await import(pathToFileURL(join(web, 'forecast-model.js')).href) as { forecastModel: (r: unknown) => any; forecastLine: (m: any) => string };
const row = (cls: string, runs: number, done: number, failed: number, mw: number): OutcomeRow => ({ cls, model: 'claude-sonnet-5-5', effort: 'high', runs, done, limit: 0, failed, pending: 0, contextStops: 0, actualMw: mw, estLowMw: null, estHighMw: null, withinRange: 0, withEstimate: 0, costUsd: null, costEstimated: false });
const sample = (cls: RunSample['cls'], mw: number, score = 0.9, costUsd: number | null = null): RunSample => ({ cls, agent: 'claude', mw, score, costUsd });
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const route = () => ({ agent: 'claude' as const, model: 'claude-sonnet-5-5' });
const calib = { claude: { lowMwPerPct: 1, highMwPerPct: 2, n: 9, source: 'measured' as const }, codex: { lowMwPerPct: 0, highMwPerPct: 0, n: 0, source: 'none' as const } };
const limits = { claude: { usedPercent: 30, reached: false, resetsAt: NOW / 1000 + 3 * 86400, windowMinutes: 10080 } };
/** n samples around `mid` with a fixed spread, the same shape for every n. */
const spread = (cls: RunSample['cls'], n: number, mid = 3): RunSample[] => Array.from({ length: n }, (_, i) => sample(cls, mid * [0.6, 1, 1.5][i % 3]!));
const base = (over: Partial<ForecastIn> = {}): ForecastIn => ({
  tasks: Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, cls: 'implement' as const })), history: [row('implement', 9, 8, 1, 3)], samples: spread('implement', 9),
  limits, calib, route, seed: 7, now: NOW, ...over,
});

test('forecast: the same seed gives the same answer, another seed another one', () => {
  const a = forecast(base()), b = forecast(base()), c = forecast(base({ seed: 8 }));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.limitPct['claude'], c.limitPct['claude']);
  assert.ok(a.enough && a.limitPct['claude']!.p90 >= a.limitPct['claude']!.p50);
});

test('forecast: more history of the same shape narrows the range (p90 - p50)', () => {
  const few = forecast(base({ samples: spread('implement', 6), history: [row('implement', 6, 6, 0, 3)] }));
  const many = forecast(base({ samples: spread('implement', 30), history: [row('implement', 30, 28, 2, 3)] }));
  const w = (f: ReturnType<typeof forecast>): number => f.limitPct['claude']!.p90 - f.limitPct['claude']!.p50;
  assert.ok(w(many) < w(few), `${w(many)} < ${w(few)}`);
});

test('forecast: zero tasks is all zeros, whatever the history', () => {
  const f = forecast(base({ tasks: [] }));
  assert.equal(f.enough, true); assert.equal(f.tasks, 0);
  assert.deepEqual(f.limitPct['claude'], { p50: 0, p90: 0, label: 'measured' });
  assert.deepEqual(f.weeks, { p50: 0, p90: 0, label: 'measured' });
  assert.equal(f.usd?.p90 ?? 0, 0);
  assert.equal(forecast(base({ tasks: [], history: [], samples: [] })).enough, true);
});

test('forecast: too little history is "недостаточно данных", never a number', () => {
  const f = forecast(base({ history: [row('implement', MIN_SETTLED - 1, MIN_SETTLED - 1, 0, 3)], samples: spread('implement', MIN_SETTLED - 1) }));
  assert.equal(f.enough, false); assert.equal(f.reason, 'недостаточно данных');
  assert.deepEqual(f.limitPct, {}); assert.equal(f.weeks, null); assert.equal(f.usd, null);
  assert.equal(f.basis, 'estimated');
  const none = forecast(base({ history: [], samples: [] }));
  assert.equal(none.enough, false);
});

test('forecast: the basis label follows the data: measured, mixed, estimated', () => {
  const measured = forecast(base());
  assert.equal(measured.basis, 'measured'); assert.equal(measured.limitPct['claude']!.label, 'measured');
  const mixed = forecast(base({ tasks: [...base().tasks, { title: 'r', cls: 'review' }] }));
  assert.equal(mixed.basis, 'mixed');
  assert.ok(mixed.risk.some((r) => /нет данных по задачам типа «ревью»/.test(r)), 'the class with no data is named as what widens the range');
  assert.equal(mixed.limitPct['claude']!.label, 'estimated', 'a number that leans on a guess is not called measured');
  const est = forecast(base({ tasks: [{ title: 'r', cls: 'review' }, { title: 'p', cls: 'plan' }] }));
  assert.equal(est.basis, 'estimated');
});

test('forecast: an agent with no limit calibration gets no percent, and a risk line says why', () => {
  const f = forecast(base({ calib: { ...calib, claude: { lowMwPerPct: 0, highMwPerPct: 0, n: 0, source: 'none' } } }));
  assert.equal(f.limitPct['claude'], undefined);
  assert.equal(f.weeks, null);
  assert.ok(f.risk.some((r) => /замеров лимита Claude нет/.test(r)));
});

test('forecast: weeks come from the limit left and the reset; a window that is not weekly is not turned into weeks', () => {
  const small = forecast(base({ tasks: [{ title: 'a', cls: 'implement' }] }));
  assert.equal(small.weeks!.p50, 0, 'fits in what is left of this window');
  const big = forecast(base({ tasks: Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, cls: 'implement' as const })) }));
  assert.ok(big.weeks!.p50 > 3 / 7, 'at least the days until the reset');
  const fiveHour = forecast(base({ limits: { claude: { ...limits.claude, windowMinutes: 300 } } }));
  assert.equal(fiveHour.weeks, null);
  assert.ok(fiveHour.risk.some((r) => /не недельный/.test(r)));
  const unknownLeft = forecast(base({ limits: { claude: { usedPercent: null, reached: false } } }));
  assert.equal(unknownLeft.weeks!.label, 'estimated');
});

test('forecast: dollars only with a priced model, and a measured cost beats a guess', () => {
  const priced = forecast(base());
  assert.ok(priced.usd && priced.usd.p50 > 0 && priced.usd.label === 'estimated', 'priced from the price table: an estimate');
  const withCost = forecast(base({ samples: spread('implement', 9).map((s) => ({ ...s, costUsd: s.mw * 0.5 })) }));
  assert.equal(withCost.usd!.label, 'measured');
  const unknown = forecast(base({ route: () => ({ agent: 'claude', model: 'claude-mystery-9' }), samples: spread('implement', 9) }));
  assert.equal(unknown.usd, null);
  assert.ok(unknown.risk.some((r) => /Цена модели claude-mystery-9 не проверена/.test(r)));
});

test('forecast: a failed sample adds a cascade rung, so lower success means more cost', () => {
  const good = forecast(base({ samples: spread('implement', 9).map((s) => ({ ...s, score: 1 })) }));
  const bad = forecast(base({ samples: spread('implement', 9).map((s) => ({ ...s, score: 0 })) }));
  assert.ok(bad.limitPct['claude']!.p50 > good.limitPct['claude']!.p50 * 1.8, 'always failing: three runs per task');
});

test('forecast: hostile input (NaN, negative, huge) cannot produce NaN, Infinity or a crash', () => {
  const f = forecast(base({ samples: [sample('implement', Number.NaN), sample('implement', -4), sample('implement', 1e300), ...spread('implement', 4)], trials: 99999999, seed: Number.NaN }));
  for (const v of [f.limitPct['claude']!.p50, f.limitPct['claude']!.p90]) assert.ok(Number.isFinite(v));
  const g = forecast(base({ tasks: Array.from({ length: 5000 }, () => ({ title: 'x', cls: 'nonsense' as never })), trials: 200 }));
  assert.ok(g.tasks <= 500, 'the task list is capped');
});

test('parseTasks: open checkboxes only, class in [brackets] or read from the text; Spec Kit ids and tags are not part of the title', () => {
  const md = ['# Tasks', '## Phase 1', '- [ ] Fix login crash [debug]', '- [x] done already [plan]', '- [ ] T004 [P] [US1] Add export to JSON', '* [ ] Rename helper [mechanical]', '- [ ] plain without class', 'not a task', '- [ ]', '- [ ] odd [nosuchclass] thing'].join('\n');
  const t = parseTasks(md);
  assert.deepEqual(t.tasks.map((x) => [x.title, x.cls]), [['Fix login crash', 'debug'], ['Add export to JSON', 'implement'], ['Rename helper', 'mechanical'], ['plain without class', 'implement'], ['odd [nosuchclass] thing', 'implement']]);
  assert.equal(t.done, 1); assert.equal(t.guessed, 3, 'classes read from the text are marked as guesses');
  assert.equal(parseTasks('x'.repeat(2_000_000)).tasks.length, 0);
});

test('model layer: reads a hostile answer by type and writes plain Russian', () => {
  assert.equal(forecastModel(null), null);
  assert.equal(forecastModel({ enough: false, reason: 'недостаточно данных' }).enough, false);
  const m = forecastModel({ enough: true, tasks: { open: 14, done: 3, total: 17, files: ['tasks.md'] }, forecast: { enough: true, tasks: 14, basis: 'mixed', limitPct: { claude: { p50: 35, p90: 60, label: 'estimated' }, codex: { p50: '<b>', p90: 20, label: 'x' } }, weeks: { p50: 1, p90: 2, label: 'estimated' }, usd: null, risk: ['<script>alert(1)</script>‮', 5] }, sampleRuns: 9 });
  assert.equal(m.open, 14);
  assert.ok(!('codex' in m.limit), 'a range with a non-number is dropped, never printed');
  assert.ok(forecastLine(m).includes('14') && /35[–-]60 %/.test(forecastLine(m)) && /Claude/.test(forecastLine(m)));
  assert.ok(m.risk.every((r: string) => !/[‮]/.test(r)), 'bidi characters are stripped');
  assert.deepEqual(m.risk.length, 1);
});

test('readProjectTasks: reads tasks.md and specs/*/tasks.md inside the folder, ignores a link out of it', async () => {
  const { readProjectTasks } = await import('./forecast-data.ts');
  const root = mkdtempSync(join(tmpdir(), 'hub-fc-'));
  try {
    mkdirSync(join(root, 'specs', 'a'), { recursive: true });
    writeFileSync(join(root, 'tasks.md'), '- [ ] one [plan]\n- [x] two\n');
    writeFileSync(join(root, 'specs', 'a', 'tasks.md'), '- [ ] three [review]\n');
    const r = readProjectTasks(root);
    assert.deepEqual(r.tasks.map((t) => t.title).sort(), ['one', 'three']);
    assert.equal(r.done, 1); assert.deepEqual(r.files.sort(), ['specs/a/tasks.md', 'tasks.md']);
    assert.deepEqual(readProjectTasks(join(root, 'nothing-here')).tasks, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void MIN_CLASS_SAMPLES;
