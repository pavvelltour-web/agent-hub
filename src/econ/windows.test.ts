import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, addLimit, latestLimit, upsertSession, addUsage } from '../history/store.ts';
import { limitSnapshots, WEEKLY_MIN_MINUTES, claudeWindowMinutes } from './limits.ts';
import { calibrate } from './econ.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { sanitizeEvent } from '../adapters/event-utils.ts';
import { suggestBeforeReset, type QueuedJob } from '../run/scheduler.ts';

/** Review fix 1: a limit reading is only used for «reset within 24 h» when its window is KNOWN to be weekly. */
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0), sec = NOW / 1000;
const job: QueuedJob = { id: 'j1', kind: 'review-existing', projectId: 1, agent: 'claude', expectedPct: 5, writes: 'none' };
const snap = (db: ReturnType<typeof openDb>, o: { agent?: string; used: number; resetsInH: number; window: number | null; ts?: string; source?: string }): void =>
  addLimit(db, { agent: o.agent ?? 'claude', ts: o.ts ?? new Date(NOW - 60_000).toISOString(), windowMinutes: o.window, usedPercent: o.used, resetsAt: Math.floor(sec + o.resetsInH * 3600), planType: null, source: o.source ?? 'cli-event' });
const fromDb = (db: ReturnType<typeof openDb>) => { const s = limitSnapshots(db, NOW); return suggestBeforeReset({ limits: { claude: s.claude ? { usedPercent: s.claude.usedPercent, reached: s.claude.reached, resetsAt: s.claude.resetsAt, ts: s.claude.ts, windowMinutes: s.claude.windowMinutes } : undefined }, queue: [job], now: NOW }); };

test('the observed case: "30 % used, resets in 3 h, no window length" is NOT offered; a 5-hour window is not offered; a weekly one is', () => {
  const a = openDb(':memory:');
  snap(a, { used: 30, resetsInH: 3, window: null });
  assert.equal(fromDb(a).length, 0, 'window length unknown: refuse');
  const b = openDb(':memory:');
  snap(b, { used: 30, resetsInH: 3, window: 300 });
  assert.equal(fromDb(b).length, 0, 'a 5 h window: its percent is not a share of the week');
  const c = openDb(':memory:');
  snap(c, { used: 30, resetsInH: 3, window: 10080 });
  assert.equal(fromDb(c).length, 1, 'a proper weekly reading still allows');
  assert.equal(WEEKLY_MIN_MINUTES, 6 * 1440);
  // the scheduler's own rule, without the database: a reading that carries no or a short window is unknown
  const lim = (windowMinutes: number | null | undefined) => suggestBeforeReset({ limits: { claude: { usedPercent: 30, reached: false, resetsAt: sec + 3 * 3600, windowMinutes } }, queue: [job], now: NOW }).length;
  assert.deepEqual([lim(undefined), lim(null), lim(300), lim(1440), lim(8639), lim(8640), lim(10080), lim(Number.NaN), lim(-1)], [0, 0, 0, 0, 0, 1, 1, 0, 0]);
});

test('both windows are stored side by side; the newest reading of ANY window never hides the weekly one', () => {
  const db = openDb(':memory:');
  snap(db, { used: 62, resetsInH: 100, window: 10080, ts: new Date(NOW - 600_000).toISOString() });
  snap(db, { used: 10, resetsInH: 2, window: 300, ts: new Date(NOW - 300_000).toISOString() });
  snap(db, { used: 63, resetsInH: 100, window: 10080, ts: new Date(NOW - 200_000).toISOString() });
  snap(db, { used: 11, resetsInH: 2, window: 300, ts: new Date(NOW - 100_000).toISOString() });
  snap(db, { used: 11, resetsInH: 2, window: 300, ts: new Date(NOW - 50_000).toISOString() });   // identical to the last 5 h reading: deduped per window
  const rows = db.prepare('SELECT window_minutes AS w, used_percent AS p FROM limit_snapshot ORDER BY id').all() as unknown as { w: number; p: number }[];
  assert.deepEqual(rows.map((r) => [r.w, r.p]), [[10080, 62], [300, 10], [10080, 63], [300, 11]]);
  assert.equal(latestLimit(db, 'claude')!.windowMinutes, 300, 'the old "newest of any window" reading is unchanged for the panel');
  const s = limitSnapshots(db, NOW).claude!;
  assert.equal(s.windowMinutes, 10080); assert.equal(s.usedPercent, 63);
});

test('an old weekly reading whose reset has passed is stale (unknown), not carried over', () => {
  const db = openDb(':memory:');
  snap(db, { used: 63, resetsInH: -2, window: 10080 });
  const s = limitSnapshots(db, NOW).claude!;
  assert.equal(s.stale, true); assert.equal(s.usedPercent, null);
  assert.equal(fromDb(db).length, 0);
});

test('calibration uses weekly readings only: a 5 h percent is not "per 1 % of the weekly limit"', () => {
  const db = openDb(':memory:');
  upsertSession(db, { id: 'claude:a', agent: 'claude', nativeId: 'a', sourceKind: 'x', sourcePath: 'p' });
  let p5 = 5, pw = 5;
  for (let i = 0; i < 7; i++) {
    const day = `2026-10-0${i + 1}`;
    addLimit(db, { agent: 'claude', ts: `${day}T10:00:00Z`, windowMinutes: 300, usedPercent: p5, resetsAt: 500 + i, planType: null, source: 'cli-event' });
    addLimit(db, { agent: 'claude', ts: `${day}T10:00:01Z`, windowMinutes: 10080, usedPercent: pw, resetsAt: 999, planType: null, source: 'cli-event' });
    addUsage(db, 'claude:a', `${day}T11:00:00Z`, 'm', { uncachedIn: 1_500_000, cachedIn: 0, out: 0 });
    p5 += 20; pw += 3;
  }
  addLimit(db, { agent: 'claude', ts: '2026-10-08T10:00:00Z', windowMinutes: 10080, usedPercent: pw, resetsAt: 999, planType: null, source: 'cli-event' });
  const c = calibrate(db, 'claude');
  assert.equal(c.source, 'measured');
  assert.ok(Math.abs(c.lowMwPerPct - 0.5) < 0.01, `1.5 Mw / 3 % = 0.5 Mw per % (got ${c.lowMwPerPct})`);
  const none = openDb(':memory:');
  upsertSession(none, { id: 'claude:a', agent: 'claude', nativeId: 'a', sourceKind: 'x', sourcePath: 'p' });
  for (let i = 0; i < 8; i++) { addLimit(none, { agent: 'claude', ts: `2026-10-0${i + 1}T10:00:00Z`, windowMinutes: null, usedPercent: 5 + i * 3, resetsAt: 999, planType: null, source: 'cli-event' }); addUsage(none, 'claude:a', `2026-10-0${i + 1}T11:00:00Z`, 'm', { uncachedIn: 1_500_000, cachedIn: 0, out: 0 }); }
  assert.equal(calibrate(none, 'claude').source, 'none', 'readings with no window length calibrate nothing');
});

test('Claude adapter: rateLimitType gives the window length; unknown types give none; the event survives sanitising', () => {
  assert.equal(claudeWindowMinutes('five_hour'), 300);
  assert.equal(claudeWindowMinutes('seven_day'), 10080);
  for (const x of ['seven_day_opus', 'seven_day_sonnet', 'seven_day_anything', 'five_hour_x', 'SEVEN_DAY', 'overage', '', 'weird', 5, null, undefined, {}]) assert.equal(claudeWindowMinutes(x), undefined, String(x));
  const ev = (type: unknown) => claudeAdapter.parse({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.3, resetsAt: Math.floor(sec) + 3 * 3600, rateLimitType: type } }).map((e) => sanitizeEvent(e)).find((e) => e.kind === 'limit') as { windowMinutes?: number; usedPercent?: number };
  assert.equal(ev('five_hour').windowMinutes, 300); assert.equal(ev('seven_day').windowMinutes, 10080); assert.equal(ev('seven_day').usedPercent, 30);
  assert.equal(ev('nonsense').windowMinutes, undefined); assert.equal(ev('seven_day_opus').windowMinutes, undefined, 'a sub-limit is not the overall week'); assert.equal(ev(undefined).windowMinutes, undefined);
});

test('S3: a sub-limit reading (an Opus-only 20 %) is stored with no window and can never allow a start while the overall week is high', () => {
  const db = openDb(':memory:');
  snap(db, { used: 95, resetsInH: 3, window: 10080, ts: new Date(NOW - 120_000).toISOString() });                 // the overall week: nearly spent
  snap(db, { used: 20, resetsInH: 3, window: claudeWindowMinutes('seven_day_opus') ?? null, ts: new Date(NOW - 60_000).toISOString() });   // a newer Opus-only reading
  const rows = db.prepare('SELECT window_minutes AS w, used_percent AS p FROM limit_snapshot ORDER BY id').all() as unknown as { w: number | null; p: number }[];
  assert.deepEqual(rows.map((r) => [r.w, r.p]), [[10080, 95], [null, 20]], 'both are stored, the sub-limit with no window');
  assert.equal(limitSnapshots(db, NOW).claude!.usedPercent, 95);
  assert.equal(fromDb(db).length, 0, 'the overall week has 5 % left: nothing is offered');
});
