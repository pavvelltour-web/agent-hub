import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrace, MAX_PAGE_TURNS, MAX_TOOLS_PER_TURN, MAX_TRACE_ROWS, pageTurns, readTraceEvents, traceJsonl } from './trace.ts';
import { MAX_TURN_ROWS, RunManager, type StoredEvent } from './runner.ts';
import { costUsd } from '../econ/econ.ts';
import { openDb } from '../history/store.ts';

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const ev = (seq: number, ms: number, kind: string, data: Record<string, unknown> = {}): StoredEvent => ({ seq, ts: at(ms), kind, data: { kind, ...data } });
const turn = (seq: number, ms: number, newIn: number, cachedIn: number, out: number): StoredEvent => ev(seq, ms, 'turn', { newIn, cachedIn, out, context: newIn + cachedIn });

/** A Claude-shaped run: three model calls (`turn` rows), tool calls inside them, and the run-level `usage` of the final result line. */
const claude = (model = 'claude-sonnet-5-5', withCost = true): StoredEvent[] => [
  ev(1, 0, 'session', { nativeId: 's1', model }),
  turn(2, 100, 15, 900, 40),
  ev(3, 110, 'tool', { id: 'a', name: 'Bash' }), ev(4, 111, 'tool', { id: 'b', name: 'Read' }),
  ev(5, 150, 'tool_result', { id: 'b', body: 'x'.repeat(200) }), ev(6, 400, 'tool_result', { id: 'a', body: 'boom', isError: true }),
  turn(7, 500, 20, 1100, 30),
  ev(8, 510, 'tool', { id: 'c', name: 'Edit' }), ev(9, 520, 'tool_result', { id: 'c', body: 'ok' }),
  turn(10, 900, 5, 1300, 20),
  ev(11, 950, 'usage', { uncachedIn: 40, cachedIn: 3300, out: 90, ...(withCost ? { costUsd: 0.05 } : {}), ms: 900 }),
  ev(12, 960, 'end', { outcome: 'done' }),
];

test('buildTrace (Claude shape): turns split at `turn` rows, tool durations from arrival times, cacheHit, run cost from the CLI', () => {
  const t = buildTrace(claude());
  assert.equal(t.turns.length, 3);
  assert.deepEqual(t.turns.map((x) => x.n), [1, 2, 3]);
  assert.deepEqual(t.turns[0]!.tokens, { newIn: 15, cachedIn: 900, out: 40, reasoning: 0 });
  assert.equal(t.turns[0]!.model, 'claude-sonnet-5-5');
  assert.equal(t.turns[0]!.startedAt, at(100));
  assert.deepEqual(t.turns[0]!.tools.map((x) => [x.name, x.ms, x.ok, x.bytes]), [['Bash', 290, false, 4], ['Read', 39, true, 200]], 'results are matched by tool id, not by order');
  assert.equal(t.turns[0]!.ms, 400, 'a turn lasts until the next turn starts');
  assert.equal(t.turns[2]!.ms, 60, 'the last turn lasts until the last event of the run');
  assert.ok(Math.abs(t.turns[0]!.cacheHit - 900 / 915) < 1e-12, 'cacheHit = cachedIn / (newIn + cachedIn)');
  assert.deepEqual(t.turns.map((x) => x.context), [915, 1120, 1305], 'context per turn grows within a session');
  assert.equal(t.turns[0]!.costUsd, costUsd('claude-sonnet-5-5', { uncachedIn: 15, cachedIn: 900, out: 40 }));
  assert.equal(typeof t.turns[0]!.costUsd, 'number');
  assert.deepEqual(t.totals, { newIn: 40, cachedIn: 3300, out: 90, reasoning: 0, ms: 960, costUsd: 0.05 }, 'tokens are summed over the turns; the cost is what the CLI reported for the whole run');
  assert.deepEqual(t.slowest[0], { name: 'Bash', ms: 290, turn: 1 });
  assert.deepEqual(t.slowest.map((x) => x.name), ['Bash', 'Read', 'Edit']);
});

test('buildTrace: a drop in context (the CLI compacted) is reported as it is, never clamped; zero input gives cacheHit 0', () => {
  const t = buildTrace([turn(1, 0, 100, 900, 5), turn(2, 10, 50, 100, 5), turn(3, 20, 0, 0, 1)]);
  assert.deepEqual(t.turns.map((x) => x.context), [1000, 150, 0]);
  assert.equal(t.turns[2]!.cacheHit, 0);
});

test('buildTrace: an unknown model has no cost (null), not 0; the run total is null too unless the CLI reported one', () => {
  const t = buildTrace(claude('mystery-model-9', false));
  assert.ok(t.turns.every((x) => x.costUsd === null));
  assert.equal(t.totals.costUsd, null);
  assert.equal(buildTrace(claude('mystery-model-9', true)).totals.costUsd, 0.05, 'the CLI figure is kept even when the hub has no price for the model');
  assert.equal(buildTrace(claude('', false), { model: 'claude-opus-5-5' }).turns[0]!.model, 'claude-opus-5-5', 'the run row names the model when the stream did not');
  assert.equal(buildTrace(claude('', false)).turns[0]!.model, '');
  const known = buildTrace(claude('claude-sonnet-5-5', false));
  assert.ok(known.turns.every((x) => typeof x.costUsd === 'number') && known.totals.costUsd !== null && Math.abs(known.totals.costUsd - known.turns.reduce((a, x) => a + (x.costUsd ?? 0), 0)) < 1e-12, 'without a CLI figure the total is the sum of the turn costs');
});

test('buildTrace (Codex shape, no turn rows): a usage event closes a turn; context is not measured (0), reasoning is kept', () => {
  const t = buildTrace([
    ev(1, 0, 'session', { nativeId: 'c1', model: 'gpt-6.1-sol' }),
    ev(2, 10, 'tool', { id: 'x', name: 'shell' }), ev(3, 60, 'tool_result', { id: 'x', body: 'out' }),
    ev(4, 100, 'usage', { uncachedIn: 100, cachedIn: 900, out: 20, reasoning: 7 }),
    ev(5, 110, 'tool', { id: 'y', name: 'apply_patch' }), ev(6, 130, 'tool_result', { id: 'y', body: '' }),
    ev(7, 200, 'usage', { uncachedIn: 10, cachedIn: 90, out: 5 }),
    ev(8, 210, 'end', { outcome: 'done' }),
  ]);
  assert.equal(t.turns.length, 2);
  assert.deepEqual(t.turns[0]!.tokens, { newIn: 100, cachedIn: 900, out: 20, reasoning: 7 });
  assert.equal(t.turns[0]!.cacheHit, 0.9);
  assert.equal(t.turns[0]!.context, 0, 'not measured: Codex reports no per-call prompt size');
  assert.deepEqual(t.turns[0]!.tools.map((x) => [x.name, x.ms]), [['shell', 50]]);
  assert.deepEqual(t.turns[1]!.tools.map((x) => x.name), ['apply_patch']);
  assert.equal(t.turns[0]!.ms, 100, 'from the first event of the turn to the usage event'); assert.equal(t.turns[1]!.ms, 100);
  assert.equal(t.totals.reasoning, 7);
});

test('buildTrace: a tool with no result (the run was stopped) is marked open, never ok; a result with no tool is ignored; an empty run is an empty trace', () => {
  const t = buildTrace([turn(1, 0, 1, 1, 1), ev(2, 5, 'tool', { id: 'z', name: 'Bash' }), ev(3, 9, 'tool_result', { id: 'ghost', body: 'x' }), ev(4, 20, 'end', { outcome: 'stopped' })]);
  assert.deepEqual(t.turns[0]!.tools.map((x) => [x.name, x.ok, x.ms, x.open]), [['Bash', false, 0, true]]);
  assert.deepEqual(buildTrace([]), { turns: [], totals: { newIn: 0, cachedIn: 0, out: 0, reasoning: 0, ms: 0, costUsd: null }, slowest: [] });
});

test('buildTrace: names are redacted again and capped (a row older than the sanitizer), hostile values never throw, memory is bounded per turn', () => {
  const key = 'sk-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4';
  const t = buildTrace([
    ev(1, 0, 'session', { model: 'm'.repeat(500) }),
    turn(2, 1, 1, 1, 1),
    ev(3, 2, 'tool', { id: 'a', name: `deploy ${key} <script>alert(1)</script>` }), ev(4, 3, 'tool', { id: { toString: 1 }, name: { toString: 1 } }),
    ev(5, 4, 'tool_result', { id: 'a', body: 5 }),
    { seq: 6, ts: 'not a date', kind: 'tool', data: null }, { seq: 7, ts: at(5), kind: 'turn', data: { newIn: 'x', cachedIn: -4, out: NaN, context: Infinity } },
  ]);
  const name = t.turns[0]!.tools[0]!.name;
  assert.ok(!name.includes(key) && name.includes('[REDACTED'), 'secret removed');
  assert.ok(name.includes('<script>'), 'markup stays plain text: the panel draws it with textContent');
  assert.ok(t.turns[0]!.model.length <= 100);
  assert.equal(t.turns[1]!.tokens.newIn, 0); assert.equal(t.turns[1]!.context, 0);
  const many: StoredEvent[] = [turn(1, 0, 1, 1, 1)];
  for (let i = 0; i < 5000; i++) many.push(ev(2 + i, 1, 'tool', { id: 'k' + i, name: 'Bash' }));
  const m = buildTrace(many);
  assert.equal(m.turns[0]!.tools.length, MAX_TOOLS_PER_TURN); assert.equal(m.turns[0]!.toolsMore, 5000 - MAX_TOOLS_PER_TURN);
});

test('pageTurns: pages by turn number, limit clamped, `next` null at the end; traceJsonl: one JSON object per line, totals last', () => {
  const t = buildTrace(claude());
  const p1 = pageTurns(t.turns, { after: 0, limit: 2 });
  assert.deepEqual(p1.turns.map((x) => x.n), [1, 2]); assert.equal(p1.next, 2); assert.equal(p1.total, 3);
  const p2 = pageTurns(t.turns, { after: 2, limit: 2 });
  assert.deepEqual(p2.turns.map((x) => x.n), [3]); assert.equal(p2.next, null);
  assert.equal(pageTurns(t.turns, { after: 0, limit: 1e9 }).turns.length, 3);
  assert.equal(pageTurns(Array.from({ length: 500 }, (_, i) => ({ ...t.turns[0]!, n: i + 1 })), { after: 0, limit: 1e9 }).turns.length, MAX_PAGE_TURNS);
  assert.equal(pageTurns(t.turns, { after: -5, limit: Number.NaN }).turns.length, 3, 'hostile numbers fall back to defaults');
  const lines = traceJsonl(t).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.deepEqual(lines.map((l) => l.type), ['turn', 'turn', 'turn', 'totals']);
});

test('readTraceEvents: reads only the kinds the trace needs, never the body of a tool result (its size only), and stops at the row cap', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO run (id, agent, started_at) VALUES ('rtest1', 'claude', ?)").run(at(0));
  const put = (seq: number, kind: string, data: unknown): void => { db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run('rtest1', seq, at(seq), kind, JSON.stringify(data)); };
  put(1, 'text', { kind: 'text', text: 'hello' });
  put(2, 'tool', { kind: 'tool', id: 'a', name: 'Bash', summary: 's', input: { command: 'x'.repeat(100_000) } });
  put(3, 'tool_result', { kind: 'tool_result', id: 'a', summary: 's', body: 'é'.repeat(100_000), lines: 1, truncated: false, isError: true });
  put(4, 'turn', { kind: 'turn', newIn: 1, cachedIn: 2, out: 3, context: 3 });
  const r = readTraceEvents(db, 'rtest1');
  assert.deepEqual(r.events.map((e) => e.kind), ['tool', 'tool_result', 'turn'], 'text rows are not read');
  const res = r.events[1]!.data as Record<string, unknown>;
  assert.equal(res['body'], undefined, 'the body does not leave the database');
  assert.equal(res['bytes'], 200_000, 'size in bytes of the UTF-8 body');
  assert.equal(JSON.stringify(r.events[0]).length < 400, true, 'the tool input does not leave the database either');
  assert.equal(r.truncated, false);
  const cut = readTraceEvents(db, 'rtest1', 2);
  assert.equal(cut.events.length, 2); assert.equal(cut.truncated, true);
  assert.ok(MAX_TRACE_ROWS >= 1000 && MAX_TRACE_ROWS <= 100_000);
  const t = buildTrace(r.events);
  assert.deepEqual(t.turns[0]!.tools.map((x) => [x.ok, x.bytes]), [[false, 200_000]], 'bytes and ok survive the slim read');
});

// ── the runner records the turns (the trace is built from stored rows, not from a transcript) ─────────────────────────────────────────────
const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };
const waitEnd = (rm: RunManager, id: string): Promise<void> => new Promise((res) => { const t = setInterval(() => { if (!rm.isLive(id) && rm.get(id)?.outcome) { clearInterval(t); setTimeout(res, 30); } }, 50); });

test('the runner stores one turn row per model call (the lines of one message are folded), keeps them out of the live stream and the event list, and the trace of a real run adds up', async () => {
  const db = openDb(':memory:'); const root = mkdtempSync(join(tmpdir(), 'hub-trace-'));
  try {
    const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-trace' }, summarize: false, home: join(root, 'home') });
    const run = rm.start({ agent: 'claude', prompt: 'trace me', projectRoot: root, model: 'sonnet' });
    const live: string[] = []; rm.subscribe(run.id, (e) => live.push(e.kind));
    await waitEnd(rm, run.id);
    assert.ok(!live.includes('turn') && !live.includes('context'), 'the panel stream never carries turn rows');
    assert.ok(!rm.events(run.id).some((e) => e.kind === 'turn'), 'events() is the transcript: no turn rows');
    const rows = db.prepare("SELECT data FROM run_event WHERE run_id = ? AND kind = 'turn' ORDER BY seq").all(run.id) as { data: string }[];
    assert.equal(rows.length, 3, 'm1 came on two lines: one turn');
    assert.equal((JSON.parse(rows[0]!.data) as { out: number }).out, 40, 'the later line of the same message carries the final output count');
    const { events } = readTraceEvents(db, run.id);
    const t = buildTrace(events, { model: rm.get(run.id)!.model ?? '' });
    assert.deepEqual(t.turns.map((x) => x.context), [915, 1017, 1110], 'prompt size of each call: input + cache writes + cache reads');
    assert.deepEqual(t.turns[0]!.tools.map((x) => [x.name, x.ok]), [['Bash', true]]);
    assert.ok(t.turns[0]!.tools[0]!.ms >= 100, `Bash took the pause before its result (${t.turns[0]!.tools[0]!.ms} ms)`);
    assert.deepEqual(t.turns[1]!.tools.map((x) => [x.name, x.ok]), [['Read', false]], 'a result with is_error is not ok');
    assert.equal(t.totals.costUsd, 0.05);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('the runner caps stored turn rows per run: a hostile CLI cannot grow the log with them', async () => {
  const db = openDb(':memory:'); const root = mkdtempSync(join(tmpdir(), 'hub-trace-cap-'));
  try {
    const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-trace', FAKE_TRACE_TURNS: String(MAX_TURN_ROWS + 300) }, summarize: false, home: join(root, 'home'), contextLimit: 0 });
    const run = rm.start({ agent: 'claude', prompt: 'many', projectRoot: root });
    await waitEnd(rm, run.id);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM run_event WHERE run_id = ? AND kind = 'turn'").get(run.id) as { n: number }).n;
    assert.equal(n, MAX_TURN_ROWS);
    assert.ok(rm.events(run.id).some((e) => e.kind === 'warn' && /шагов больше/.test((e.data as { message: string }).message)), 'the user is told once that the trace is cut');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
