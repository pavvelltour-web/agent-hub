import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'hub-trace-api-'));
process.env['USERPROFILE'] = home; process.env['HOME'] = home; process.env['AGENT_HUB_HOME'] = join(home, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
const db = openDb(':memory:');
const runs = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-trace' }, summarize: false });
const srv = await startServer({ db, runs } as never);
const root = mkdtempSync(join(tmpdir(), 'hub-trace-apiroot-'));
after(async () => { await srv.close(); for (const d of [home, root]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
const cookie = `hub_token=${srv.token}`;
const raw = (path: string, c: string | null = cookie): Promise<Response> => fetch(`http://127.0.0.1:${srv.port}${path}`, { headers: c ? { cookie: c } : {} });
const api = async (path: string): Promise<{ status: number; json: any }> => { const r = await raw(path); return { status: r.status, json: await r.json().catch(() => null) }; };
const until = async (fn: () => boolean, ms = 15000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

const run = runs.start({ agent: 'claude', prompt: 'trace me', projectRoot: root, model: 'sonnet' });
await until(() => !runs.isLive(run.id) && !!runs.get(run.id)?.outcome);

test('GET /api/runs/:id/trace: turns with tool names, tokens and durations, totals and the slowest steps; no tool input or output text', async () => {
  const r = await api(`/api/runs/${run.id}/trace`);
  assert.equal(r.status, 200);
  assert.equal(r.json.turns.length, 3); assert.equal(r.json.total, 3); assert.equal(r.json.next, null); assert.equal(r.json.truncated, false);
  assert.equal(r.json.run.id, run.id); assert.equal(r.json.run.agent, 'claude');
  assert.deepEqual(r.json.turns[0].tools.map((t: { name: string }) => t.name), ['Bash']);
  assert.equal(r.json.turns[0].context, 915);
  assert.equal(r.json.totals.costUsd, 0.05);
  assert.equal(r.json.slowest[0].name, 'Bash');
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes('npm test') && !text.includes('no such file'), 'inputs and outputs of tools never appear in a trace');
});

test('GET trace pages by turn number; the limit is clamped; bad ids and unknown runs are refused', async () => {
  const p1 = await api(`/api/runs/${run.id}/trace?limit=2`);
  assert.deepEqual(p1.json.turns.map((t: { n: number }) => t.n), [1, 2]); assert.equal(p1.json.next, 2);
  const p2 = await api(`/api/runs/${run.id}/trace?after=${p1.json.next}&limit=2`);
  assert.deepEqual(p2.json.turns.map((t: { n: number }) => t.n), [3]); assert.equal(p2.json.next, null);
  assert.equal((await api(`/api/runs/${run.id}/trace?limit=99999999`)).json.turns.length, 3);
  assert.equal((await api(`/api/runs/${run.id}/trace?after=abc&limit=-3`)).status, 200, 'hostile numbers fall back to defaults');
  assert.equal((await api('/api/runs/NOTAID/trace')).status, 400);
  assert.equal((await api('/api/runs/rzzzzzz/trace')).status, 404);
  assert.equal((await raw(`/api/runs/${run.id}/trace`, null)).status, 401, 'needs the session cookie like every API call');
});

test('GET trace.jsonl: a download with one JSON object per line, turns then totals, safe headers', async () => {
  const r = await raw(`/api/runs/${run.id}/trace.jsonl`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="trace-${run.id}.jsonl"`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.deepEqual(lines.map((l) => l.type), ['turn', 'turn', 'turn', 'totals']);
  assert.equal((await raw('/api/runs/NOTAID/trace.jsonl')).status, 400);
  assert.equal((await raw('/api/runs/rzzzzzz/trace.jsonl')).status, 404);
});

test('a row stored before the sanitizer existed (a secret in a tool name) is redacted again on the way out', async () => {
  const key = 'sk-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4';
  db.prepare("INSERT INTO run (id, agent, started_at, outcome) VALUES ('rold1', 'claude', ?, 'done')").run(new Date().toISOString());
  db.prepare("INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES ('rold1', 1, ?, 'tool', ?)").run(new Date().toISOString(), JSON.stringify({ kind: 'tool', id: 'a', name: `deploy ${key}` }));
  const r = await api('/api/runs/rold1/trace');
  assert.ok(!JSON.stringify(r.json).includes(key)); assert.match(JSON.stringify(r.json), /REDACTED/);
  assert.equal(r.json.turns.length, 1, 'an old run (no turn rows) is one step with what was recorded');
});

test('GET /api/logs rows carry the run\'s model and project so the journal can filter by them', async () => {
  const r = await api('/api/logs?limit=50');
  const end = r.json.find((x: { runId?: string; source: string }) => x.runId === run.id && x.source === 'end');
  assert.ok(end); assert.equal(end.model, runs.get(run.id)!.model); assert.equal(end.projectId, runs.get(run.id)!.projectId);
});

// ── 7.2: the context gauge's endpoint ─────────────────────────────────────────────────────────────────────────────────────────────────────
const { reloadPrices } = await import('../econ/prices.ts');
const { writeFileSync: wf, rmSync: rm } = await import('node:fs');
const hubHome = process.env['AGENT_HUB_HOME'] as string;

test('GET /api/runs/:id/context: latest per-call size, the first call as baseline, parts that add up, no window unless the price table names one', async () => {
  wf(join(root, 'AGENTS.md'), 'rule line\n'.repeat(400));   // 4000 bytes: about 1000 tokens, read by SIZE only
  const r = await api(`/api/runs/${run.id}/context`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.used, r.json.firstCall, r.json.turns, r.json.window, r.json.level, r.json.handoffAt, r.json.amberAt], [1110, 915, 3, null, 'ok', 250_000, 200_000], 'the bundled price table names no window: it stays unknown');
  const b = r.json.breakdown;
  assert.equal(b.system + b.rules + b.skills + b.conversation, b.used); assert.equal(b.used, 1110); assert.equal(b.window, null);
  assert.equal(b.conversation, 1110 - 915); assert.equal(r.json.estimated, true); assert.ok(r.json.rulesTokens >= 1000 && r.json.rulesTokens <= 1010, `rules ≈ size/4, got ${r.json.rulesTokens}`);
  assert.equal(r.json.cache.ttlSec, 300); assert.ok(r.json.cache.ageSec >= 0 && r.json.cache.ageSec < 60);
  assert.ok(!JSON.stringify(r.json).includes('rule line'), 'the text of a rules file is never read');
});

test('context: a window from the price table is passed on; red from 250K; a run with no measured calls says so; bad ids and unknown runs are refused', async () => {
  wf(join(hubHome, 'prices.json'), JSON.stringify({ version: 1, models: { 'claude-sonnet-5-5': { tiers: [{ input: 3, cacheRead: 0.3, output: 15 }], source: 'test', date: '2026-10-27', window: 1_000_000 } } }));
  reloadPrices(hubHome);
  try {
    assert.equal((await api(`/api/runs/${run.id}/context`)).json.window, 1_000_000);
    db.prepare("INSERT INTO run (id, agent, model, started_at, outcome) VALUES ('rbig1', 'claude', 'claude-sonnet-5-5', ?, 'done')").run(new Date().toISOString());
    for (const [seq, c] of [[1, 30_000], [2, 120_000], [3, 255_000]] as const) db.prepare("INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES ('rbig1', ?, ?, 'turn', ?)").run(seq, new Date(Date.now() - 400_000).toISOString(), JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: c - 1, out: 1, context: c }));
    const big = (await api('/api/runs/rbig1/context')).json;
    assert.deepEqual([big.used, big.level, big.breakdown.turnsLeft], [255_000, 'red', 0]);
    assert.ok(big.cache.ageSec >= 399, 'the last call was 400 s ago: the cache has gone cold');
  } finally { rm(join(hubHome, 'prices.json'), { force: true }); reloadPrices(hubHome); }
  db.prepare("INSERT INTO run (id, agent, model, started_at, outcome) VALUES ('rcodex2', 'codex', 'gpt-6.1-sol', ?, 'done')").run(new Date().toISOString());
  const cx = (await api('/api/runs/rcodex2/context')).json;
  assert.deepEqual([cx.used, cx.level, cx.breakdown, cx.cache, cx.turns], [null, null, null, null, 0]);
  assert.equal((await api('/api/runs/NOTAID/context')).status, 400); assert.equal((await api('/api/runs/rzzzzzz/context')).status, 404);
  assert.equal((await raw(`/api/runs/${run.id}/context`, null)).status, 401);
});
