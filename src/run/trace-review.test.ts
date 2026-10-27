import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedTrace, readTraceEvents, buildTrace, traceCacheSize, TRACE_CACHE_MAX } from './trace.ts';
import { RunManager } from './runner.ts';
import { openDb } from '../history/store.ts';

const at = (s: number): string => new Date(Date.parse('2026-10-27T10:00:00Z') + s * 1000).toISOString();
function seeded() {
  const db = openDb(':memory:');
  const run = (id: string): void => { db.prepare('INSERT INTO run (id, agent, started_at) VALUES (?, ?, ?)').run(id, 'claude', at(0)); };
  const put = (id: string, seq: number, kind: string, data: string): void => { db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, seq, at(seq), kind, data); };
  return { db, run, put };
}

test('N1: one damaged row (data that is not JSON) does not break the trace: it reads as an empty row, the others are still read', () => {
  const { db, run, put } = seeded(); run('rbad1');
  put('rbad1', 1, 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: 2, out: 3, context: 3 }));
  put('rbad1', 2, 'tool', '{not json at all');
  put('rbad1', 3, 'tool_result', '');
  put('rbad1', 4, 'tool', JSON.stringify({ kind: 'tool', id: 'a', name: 'Bash' }));
  const r = readTraceEvents(db, 'rbad1');
  assert.deepEqual(r.events.map((e) => e.kind), ['turn', 'tool', 'tool_result', 'tool']);
  const t = buildTrace(r.events);
  assert.equal(t.turns.length, 1); assert.deepEqual(t.turns[0]!.tools.map((x) => x.name), ['unknown', 'Bash'], 'a damaged tool row is a tool with no name, not an error');
});

test('N2: run_event has an index on (run_id, kind, seq), created idempotently on an existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-idx-'));
  try {
    const cols = (db: ReturnType<typeof openDb>): string[][] => (db.prepare("SELECT name FROM pragma_index_list('run_event')").all() as { name: string }[]).map((i) => (db.prepare(`SELECT name FROM pragma_index_info('${i.name}') ORDER BY seqno`).all() as { name: string }[]).map((c) => c.name));
    const file = join(dir, 'h.db'); let db = openDb(file);
    assert.ok(cols(db).some((c) => c.join() === 'run_id,kind,seq'), 'a new database has it');
    db.exec('DROP INDEX run_event_kind'); db.close();
    db = openDb(file);
    assert.ok(cols(db).some((c) => c.join() === 'run_id,kind,seq'), 'an old database gets it on open');
    db.close(); db = openDb(file); db.close();   // a third open does not fail
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('N2: a trace is built once per run and kept until the run writes another row; the cache is bounded and left-over runs do not pile up', () => {
  const { db, run, put } = seeded(); run('rc1');
  put('rc1', 1, 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: 1, out: 1, context: 2 }));
  const a = cachedTrace(db, 'rc1', {}), b = cachedTrace(db, 'rc1', {});
  assert.equal(a, b, 'the same answer object while nothing was written');
  put('rc1', 2, 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: 1, out: 1, context: 4 }));
  const c = cachedTrace(db, 'rc1', {});
  assert.notEqual(c, a); assert.equal(c.trace.turns.length, 2, 'a new row rebuilds it');
  for (let i = 0; i < TRACE_CACHE_MAX + 5; i++) { run('rx' + i); put('rx' + i, 1, 'end', '{"outcome":"done"}'); cachedTrace(db, 'rx' + i, {}); }
  assert.ok(traceCacheSize(db) <= TRACE_CACHE_MAX, `bounded (${traceCacheSize(db)})`);
  assert.notEqual(cachedTrace(openDb(':memory:'), 'rc1', {}), a, 'another database never shares an entry');
});

const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
test('N2: the size of a tool result is stored when it is written (`bytes`), so a trace page does not have to measure a 64 KB body', async () => {
  const db = openDb(':memory:'); const root = mkdtempSync(join(tmpdir(), 'hub-bytes-'));
  try {
    const fakeExe = { cmd: process.execPath, prefix: [fake] };
    const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-trace' }, summarize: false, home: join(root, 'home') });
    const run = rm.start({ agent: 'claude', prompt: 'x', projectRoot: root });
    await new Promise<void>((res) => { const t = setInterval(() => { if (!rm.isLive(run.id) && rm.get(run.id)?.outcome) { clearInterval(t); setTimeout(res, 30); } }, 50); });
    const rows = db.prepare("SELECT json_extract(data, '$.bytes') AS bytes, length(CAST(json_extract(data, '$.body') AS BLOB)) AS len FROM run_event WHERE run_id = ? AND kind = 'tool_result'").all(run.id) as { bytes: number | null; len: number }[];
    assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.bytes === r.len && r.len > 0), JSON.stringify(rows));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
