import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'hub-p7-api-'));
process.env['USERPROFILE'] = home; process.env['HOME'] = home; process.env['AGENT_HUB_HOME'] = join(home, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb, projectId, addLimit } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');

const db = openDb(':memory:');
const runs = new RunManager(db, { summarize: false, home: process.env['AGENT_HUB_HOME'] as string });
const srv = await startServer({ db, runs } as never);
const root = mkdtempSync(join(tmpdir(), 'hub-p7-root-'));
after(async () => { await srv.close(); for (const d of [home, root]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
const cookie = `hub_token=${srv.token}`;
const origin = `http://127.0.0.1:${srv.port}`;
const raw = (path: string, c: string | null = cookie, init: RequestInit = {}): Promise<Response> => fetch(origin + path, { ...init, headers: { ...(c ? { cookie: c } : {}), ...(init.headers as Record<string, string> | undefined) } });
const get = async (path: string): Promise<{ status: number; json: any }> => { const r = await raw(path); return { status: r.status, json: await r.json().catch(() => null) }; };
const pid = projectId(db, root);

const seedRun = (i: number, cls: string, tokens: { tin: number; tc: number; tout: number }, outcome = 'done'): void => {
  db.prepare("INSERT INTO run (id, project_id, agent, model, effort, prompt, cwd, started_at, ended_at, outcome, cls, tokens_in, tokens_cached, tokens_out, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`rseed${i}`, pid, 'claude', 'claude-sonnet-5-5', 'high', 'x', root, new Date(Date.now() - i * 3600_000).toISOString(), new Date().toISOString(), outcome, cls, tokens.tin, tokens.tc, tokens.tout, null);
};

test('GET /api/projects/:id/forecast: with no history it says «недостаточно данных» and gives no numbers', async () => {
  writeFileSync(join(root, 'tasks.md'), '- [ ] Fix login [debug]\n- [x] done one\n- [ ] Add export\n');
  const r = await get(`/api/projects/${pid}/forecast`);
  assert.equal(r.status, 200);
  assert.equal(r.json.enough, false); assert.equal(r.json.reason, 'недостаточно данных');
  assert.deepEqual(r.json.forecast.limitPct, {}); assert.equal(r.json.forecast.weeks, null); assert.equal(r.json.forecast.usd, null);
  assert.equal(r.json.tasks.open, 2); assert.equal(r.json.tasks.done, 1); assert.equal(r.json.tasks.total, 3);
  assert.deepEqual(r.json.tasks.files, ['tasks.md']);
  assert.ok(!JSON.stringify(r.json).includes('Fix login'), 'task titles are not echoed back');
});

test('GET forecast: with enough finished runs it returns labelled ranges that follow the data', async () => {
  for (let i = 0; i < 8; i++) seedRun(i, 'implement', { tin: 600_000 + i * 50_000, tc: 400_000, tout: 20_000 });
  seedRun(20, 'debug', { tin: 900_000, tc: 500_000, tout: 30_000 }, 'failed');
  addLimit(db, { agent: 'claude', ts: new Date().toISOString(), windowMinutes: 10080, usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 2 * 86400, planType: null, source: 'manual' });
  const r = await get(`/api/projects/${pid}/forecast`);
  assert.equal(r.status, 200); assert.equal(r.json.enough, true);
  assert.equal(r.json.forecast.tasks, 2);
  assert.ok(['measured', 'mixed', 'estimated'].includes(r.json.forecast.basis));
  assert.equal(r.json.forecast.usd.label === 'measured' || r.json.forecast.usd.label === 'estimated', true);
  assert.ok(r.json.forecast.usd.p50 > 0 && r.json.forecast.usd.p90 >= r.json.forecast.usd.p50);
  assert.equal(r.json.forecast.limitPct.claude, undefined, 'Claude has no measured limit calibration here: no percent, never a made-up one');
  assert.ok(r.json.forecast.risk.some((x: string) => /замеров лимита Claude нет/.test(x)));
  const again = await get(`/api/projects/${pid}/forecast`);
  assert.deepEqual(again.json.forecast, r.json.forecast, 'the same data shows the same range each time the page opens');
});

test('GET forecast: unknown project, bad id and a missing cookie are refused; a hostile tasks.md is just text', async () => {
  assert.equal((await get('/api/projects/99999/forecast')).status, 404);
  assert.equal((await raw(`/api/projects/${pid}/forecast`, null)).status, 401);
  writeFileSync(join(root, 'tasks.md'), '- [ ] <script>alert(1)</script> [review]\n'.repeat(900));
  const r = await get(`/api/projects/${pid}/forecast`);
  assert.equal(r.status, 200); assert.equal(r.json.tasks.open, 500); assert.equal(r.json.tasks.truncated, true);
  assert.ok(!JSON.stringify(r.json).includes('<script>'));
  rmSync(join(root, 'tasks.md'));
  const none = await get(`/api/projects/${pid}/forecast`);
  assert.equal(none.json.tasks.open, 0); assert.equal(none.json.forecast.tasks, 0);
});
