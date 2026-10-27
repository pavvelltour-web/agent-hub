import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AMBER_AT, HANDOFF_AT, CACHE_TTL_SEC, cacheState, contextBreakdown, contextLevel, modelWindow, readContext } from './context.ts';
import { parsePrices, saveOverride } from './prices.ts';
import { CONTEXT_LIMIT } from '../run/runner.ts';
import { openDb } from '../history/store.ts';

const base = { firstCall: 20_000, rulesTokens: 2_000, skillsTokens: 18_000, lastContext: 64_000, window: 1_000_000, turns: 5 };

test('contextBreakdown: system is the first call minus rules and skills (measured), conversation is the growth since, and the parts add up to what is used', () => {
  const b = contextBreakdown(base);
  assert.deepEqual([b.system, b.rules, b.skills, b.conversation, b.used], [0, 2_000, 18_000, 44_000, 64_000], 'rules + skills use up the whole first call here');
  const c = contextBreakdown({ ...base, firstCall: 30_000 });
  assert.deepEqual([c.system, c.rules, c.skills, c.conversation], [10_000, 2_000, 18_000, 34_000]);
  for (const o of [base, { ...base, firstCall: 30_000 }, { ...base, rulesTokens: 50_000 }, { ...base, skillsTokens: 90_000, rulesTokens: 1 }, { ...base, lastContext: 5_000 }, { ...base, firstCall: 0 }, { ...base, lastContext: 0 }]) {
    const r = contextBreakdown(o);
    assert.equal(r.system + r.rules + r.skills + r.conversation, r.used, JSON.stringify(o));
    assert.ok([r.system, r.rules, r.skills, r.conversation].every((x) => x >= 0 && Number.isFinite(x)), 'no negative part: estimates larger than the measured first call are cut');
  }
  assert.equal(contextBreakdown({ ...base, lastContext: 5_000 }).conversation, 0, 'a context smaller than the first call (the CLI compacted) has no conversation part');
});

test('contextBreakdown: turnsLeft comes from the mean growth per step and is null with fewer than two steps or no growth; the window may be unknown', () => {
  assert.equal(contextBreakdown(base).turnsLeft, Math.floor((HANDOFF_AT - 64_000) / ((64_000 - 20_000) / 4)), 'growth 11 000 per step');
  assert.equal(contextBreakdown({ ...base, turns: 1 }).turnsLeft, null); assert.equal(contextBreakdown({ ...base, turns: 0 }).turnsLeft, null);
  assert.equal(contextBreakdown({ ...base, lastContext: 20_000 }).turnsLeft, null, 'no growth: no estimate'); assert.equal(contextBreakdown({ ...base, lastContext: 10_000 }).turnsLeft, null);
  assert.equal(contextBreakdown({ ...base, lastContext: 260_000 }).turnsLeft, 0, 'already past the line');
  assert.equal(contextBreakdown({ ...base, window: null }).window, null, 'unknown window stays unknown, never a guess');
  assert.equal(contextBreakdown(base).handoffAt, 250_000);
  const hostile = contextBreakdown({ firstCall: NaN, rulesTokens: -5, skillsTokens: Infinity, lastContext: 'x' as never, window: 0, turns: 2.7 });
  assert.equal(hostile.used, 0); assert.equal(hostile.window, null, 'a window of 0 is no window'); assert.equal(hostile.turnsLeft, null);
});

test('thresholds: amber from 200K, red from 250K (the runner stops at the same number); the cache goes cold after the 5-minute TTL', () => {
  assert.equal(HANDOFF_AT, CONTEXT_LIMIT, 'one number for the gauge and the runner (ADR-018)'); assert.equal(AMBER_AT, 200_000);
  assert.deepEqual([199_999, 200_000, 249_999, 250_000, 900_000].map((u) => contextLevel(u)), ['ok', 'amber', 'amber', 'red', 'red']);
  assert.equal(contextLevel(0), 'ok'); assert.equal(contextLevel(Number.NaN), 'ok');
  assert.equal(CACHE_TTL_SEC, 300);
  assert.deepEqual(cacheState(0), { state: 'warm' }); assert.deepEqual(cacheState(120), { state: 'warm' });
  assert.deepEqual(cacheState(121), { state: 'cooling', secondsLeft: 179 }); assert.deepEqual(cacheState(299), { state: 'cooling', secondsLeft: 1 });
  assert.deepEqual(cacheState(300), { state: 'cold' }); assert.deepEqual(cacheState(99_999), { state: 'cold' });
  assert.deepEqual(cacheState(-5), { state: 'warm' }); assert.deepEqual(cacheState(Number.NaN), { state: 'warm' });
});

test('modelWindow: only from the price table (`window` on a row); a model without one, an unknown model and a bad value give null', () => {
  const t = parsePrices({ models: {
    'claude-sonnet-5-5': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 's', date: '2026-10-27', window: 1_000_000 },
    'claude-opus-5-5': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 's', date: '2026-10-27' },
    'bad-a': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 's', date: '2026-10-27', window: 0 },
    'bad-b': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 's', date: '2026-10-27', window: '1M' },
    'bad-c': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 's', date: '2026-10-27', window: 1e15 },
  } });
  const table = { models: t.models, overridden: new Set<string>(), rejected: 0, rejectedRows: [] };
  assert.equal(modelWindow('claude-sonnet-5-5', table), 1_000_000); assert.equal(modelWindow('sonnet', table), 1_000_000, 'the CLI alias resolves like it does for prices');
  assert.equal(modelWindow('claude-opus-5-5', table), null); assert.equal(modelWindow('never-heard-of-it', table), null); assert.equal(modelWindow(null, table), null); assert.equal(modelWindow('', table), null);
  for (const id of ['bad-a', 'bad-b', 'bad-c']) { assert.ok(t.models.has(id), 'a bad window does not cost the model its price'); assert.equal(modelWindow(id, table), null, id); }
  assert.equal(modelWindow('claude-haiku-5-5'), null, 'the bundled table names no window: nothing is guessed');
});

test('saveOverride keeps the `window` the user wrote on a row when only its price changes', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-win-'));
  try {
    writeFileSync(join(home, 'prices.json'), JSON.stringify({ version: 1, models: { 'my-model': { tiers: [{ input: 1, cacheRead: 1, output: 1 }], source: 'me', date: '2026-10-27', window: 500_000 } } }));
    saveOverride(home, 'my-model', { input: 2, cacheRead: 0.5, output: 8 });
    const row = (JSON.parse(readFileSync(join(home, 'prices.json'), 'utf8')) as { models: Record<string, { window?: number; tiers: { input: number }[] }> }).models['my-model']!;
    assert.equal(row.tiers[0]!.input, 2); assert.equal(row.window, 500_000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── what the server reads for one chat thread ─────────────────────────────────────────────────────────────────────────────────────────────
const ts = (s: number): string => new Date(Date.parse('2026-10-27T10:00:00Z') + s * 1000).toISOString();
function seed() {
  const db = openDb(':memory:');
  const run = (id: string, o: { resumeOf?: string; handoffOf?: string; agent?: string } = {}): void => { db.prepare('INSERT INTO run (id, agent, started_at, resume_of, handoff_of) VALUES (?,?,?,?,?)').run(id, o.agent ?? 'claude', ts(0), o.resumeOf ?? null, o.handoffOf ?? null); };
  const turn = (id: string, seq: number, s: number, context: number): void => { db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, seq, ts(s), 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: context - 1, out: 1, context })); };
  return { db, run, turn };
}

test('readContext: the first call of the THREAD (its oldest run) is the baseline, the newest step is what is used, steps are counted over the whole thread', () => {
  const { db, run, turn } = seed();
  run('rroot'); turn('rroot', 2, 10, 20_000); turn('rroot', 5, 20, 30_000);
  run('rsecond', { resumeOf: 'rroot' }); turn('rsecond', 2, 100, 35_000); turn('rsecond', 3, 110, 41_000);
  const c = readContext(db, 'rsecond')!;
  assert.deepEqual([c.firstCall, c.used, c.turns, c.lastTs], [20_000, 41_000, 4, ts(110)]);
  const only = readContext(db, 'rroot')!;
  assert.deepEqual([only.firstCall, only.used, only.turns], [20_000, 30_000, 2], 'asking for the older run does not look forward');
  run('rempty', { resumeOf: 'rsecond' });
  const e = readContext(db, 'rempty')!;
  assert.deepEqual([e.firstCall, e.used, e.turns], [20_000, 41_000, 4], 'a run that has not made a call yet shows what the thread had');
  run('rfresh', { handoffOf: 'rsecond' }); turn('rfresh', 2, 200, 6_000);
  const f = readContext(db, 'rfresh')!;
  assert.deepEqual([f.firstCall, f.used, f.turns], [6_000, 6_000, 1], 'a handoff starts a fresh session: its own baseline');
});

test('readContext: no step rows (Codex, an old run) means nothing measured; an unknown run is undefined; a hostile resume link cannot loop or leave the database', () => {
  const { db, run, turn } = seed();
  run('rcodex', { agent: 'codex' });
  assert.deepEqual(readContext(db, 'rcodex'), { turns: 0, firstCall: null, used: null, lastTs: null });
  assert.equal(readContext(db, 'rnone'), undefined);
  run('rloopa', { resumeOf: 'rloopb' }); run('rloopb', { resumeOf: 'rloopa' }); turn('rloopa', 1, 0, 9_000);
  const l = readContext(db, 'rloopa')!; assert.equal(l.used, 9_000);
  run('rsess', { resumeOf: 'session:abc' }); turn('rsess', 1, 0, 7_000);
  assert.equal(readContext(db, 'rsess')!.firstCall, 7_000, 'a resume of a history session has no run to follow');
  db.prepare("INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES ('rsess', 2, ?, 'turn', ?)").run(ts(5), '{"context":"many"}');
  assert.equal(readContext(db, 'rsess')!.used, 0, 'a damaged row reads as 0, not as an error');
});

// ── the panel's data layer (plain JS, tested here with the rest of the gauge) ───────────────────────────────────────────────────────────────
const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'context-model.js')).href) as { contextModel: (r: unknown) => any; gaugeText: (m: any) => string[]; segments: (m: any) => any[]; cacheLine: (m: any, elapsedSec: number) => { text: string; tone: string } | null; tokText: (n: unknown) => string };
const answer = { runId: 'rab12', agent: 'claude', live: false, model: 'claude-sonnet-5-5', turns: 5, used: 64_000, firstCall: 20_000, window: 1_000_000, level: 'ok', handoff: 'restart', limit: 250_000, handoffAt: 250_000, amberAt: 200_000, rulesTokens: 2_000, skillsTokens: 18_000, estimated: true, cache: { ageSec: 100, ttlSec: 300 },
  breakdown: { system: 0, rules: 2_000, skills: 18_000, conversation: 44_000, used: 64_000, window: 1_000_000, turnsLeft: 16, handoffAt: 250_000 } };

test('gauge text: «Контекст 64 тыс из 1 млн · правила · скиллы · разговор · до передачи»; an unknown window says so and has no bar', () => {
  const m = M.contextModel(answer);
  assert.deepEqual(M.gaugeText(m), ['Контекст 64 тыс из 1 млн', 'правила ≈ 2 тыс', 'скиллы ≈ 18 тыс', 'разговор 44 тыс', 'до передачи ≈ 16 шагов']);
  assert.deepEqual(M.segments(m).map((s: any) => s.kind), ['rules', 'skills', 'conversation'], 'a zero system part is not drawn');
  assert.ok(Math.abs(M.segments(m).reduce((a: number, s: any) => a + s.pct, 0) - 6.4) < 1e-9, 'the bar is scaled to the window: 64K of 1M is 6.4 %');
  const u = M.contextModel({ ...answer, window: null, breakdown: { ...answer.breakdown, window: null } });
  assert.deepEqual(M.gaugeText(u).slice(0, 2), ['Контекст 64 тыс', 'окно неизвестно']); assert.deepEqual(M.segments(u), [], 'no window, no bar');
  const none = M.contextModel({ ...answer, used: null, breakdown: null, firstCall: null });
  assert.deepEqual(M.gaugeText(none), ['Контекст ещё не измерен']);
  assert.equal(M.contextModel({ ...answer, level: 'red' }).level, 'red'); assert.equal(M.contextModel({ ...answer, level: 'purple' }).level, 'ok', 'an unknown level is not a colour class');
  assert.equal(M.gaugeText(M.contextModel({ ...answer, breakdown: { ...answer.breakdown, turnsLeft: null } })).some((t: string) => t.startsWith('до передачи')), false);
  assert.equal(M.gaugeText(M.contextModel({ ...answer, breakdown: { ...answer.breakdown, turnsLeft: 0 } })).at(-1), 'до передачи меньше шага', 'under the line but less than one more step of room');
  assert.equal(M.gaugeText(M.contextModel({ ...answer, level: 'red', breakdown: { ...answer.breakdown, turnsLeft: 0 } })).at(-1), 'до передачи: пора', 'at or past the line');
});

test('cache line: nothing while warm, «остынет через N мин» while cooling, a plain warning when cold; the clock keeps running between polls', () => {
  const m = M.contextModel({ ...answer, cache: { ageSec: 100, ttlSec: 300 } });
  assert.equal(M.cacheLine(m, 0), null);
  assert.deepEqual(M.cacheLine(m, 30), { text: 'Кэш остынет через 3 мин', tone: 'warn' }, '130 s old: 170 s left = 3 min');
  assert.deepEqual(M.cacheLine(m, 250), { text: 'Кэш остыл: следующее сообщение дороже', tone: 'warn' });
  assert.equal(M.cacheLine(M.contextModel({ ...answer, cache: null }), 500), null);
  assert.equal(M.cacheLine(M.contextModel({ ...answer, live: true }), 500), null, 'while the agent works the cache is being used');
  assert.equal(M.cacheLine(M.contextModel({ ...answer, agent: 'codex' }), 500), null, 'the 5-minute rule is Anthropic’s, not claimed for Codex');
});

test('contextModel: hostile or malformed answers never throw and never become strings', () => {
  assert.equal(M.contextModel(null), null); assert.equal(M.contextModel('x'), null); assert.equal(M.contextModel([]), null);
  const m = M.contextModel({ runId: '../x', agent: { a: 1 }, model: ['m'], used: 'lots', window: { a: 1 }, level: { toString: 1 }, turns: -3, rulesTokens: NaN, cache: { ageSec: 'x' }, breakdown: { turnsLeft: 'soon', conversation: Infinity } });
  assert.equal(m.used, null); assert.equal(m.window, null); assert.equal(m.level, 'ok'); assert.equal(m.agent, ''); assert.equal(m.model, ''); assert.equal(m.cache, null);
  assert.deepEqual(M.gaugeText(m), ['Контекст ещё не измерен']);
  assert.equal(M.tokText(64_000), '64 тыс'); assert.equal(M.tokText(1_000_000), '1 млн'); assert.equal(M.tokText(1_500_000), '1,5 млн'); assert.equal(M.tokText(900), '900'); assert.equal(M.tokText('x'), '0');
});
