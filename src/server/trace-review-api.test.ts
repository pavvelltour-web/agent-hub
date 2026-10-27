import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'hub-trace-rev-'));
process.env['USERPROFILE'] = home; process.env['HOME'] = home; process.env['AGENT_HUB_HOME'] = join(home, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { handle } = await import('./api.ts');
const { routeHeaders } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { createSkillsEstimator } = await import('../econ/skills-estimate.ts');

const db = openDb(':memory:');
const root = mkdtempSync(join(tmpdir(), 'hub-trace-rev-root-'));
const hubHome = join(home, '.agent-hub');
after(() => { for (const d of [home, root]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
db.prepare("INSERT INTO project (id, key, root, slug) VALUES (1, 'k', ?, 'p')").run(root);
const ts = new Date().toISOString();
const run = (id: string, o: { agent?: string; branch?: string | null; workMode?: string | null; handoffOf?: string | null; outcome?: string } = {}): void => {
  db.prepare('INSERT INTO run (id, project_id, agent, model, cwd, branch, started_at, outcome, work_mode, handoff_of) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, 1, o.agent ?? 'claude', 'claude-sonnet-5-5', root, o.branch ?? null, ts, o.outcome ?? 'done', o.workMode ?? null, o.handoffOf ?? null);
  [20_000, 64_000].forEach((c, i) => db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, i + 1, ts, 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: c - 1, out: 1, context: c })));
};
const mkRuns = (contextLimit?: number): InstanceType<typeof RunManager> => new RunManager(db, { home: hubHome, summarize: false, ...(contextLimit !== undefined ? { contextLimit } : {}) });
const quick = createSkillsEstimator({ compute: async () => ({ claude: 0, codex: 0 }), fingerprint: () => 'x' });
const ctx = (runs = mkRuns(), skills = quick) => ({ db, runs, skills } as never);
const get = async (c: never, id: string): Promise<{ status: number; json: any }> => { const r = await handle(c, 'GET', `/api/runs/${id}/context`, new URLSearchParams(), {}); return { status: r.status, json: r.json }; };

test('S3: the gauge reports what the runner will really do at the limit: restart in a hub task folder, warn in a chat, a reviewer, a cascade step or a capped chain; off with no limit; and the limit in force', async () => {
  run('rown1', { branch: 'hub/t/claude' }); run('rchat1'); run('rrev1', { branch: 'hub/t/claude', workMode: 'gate-reviewer' });
  run('rcasc1', { branch: 'hub/t2/claude' });
  mkdirSync(join(hubHome, 'cascades'), { recursive: true });
  writeFileSync(join(hubHome, 'cascades', 'rca1.json'), JSON.stringify({ id: 'rca1', status: 'running', startedAt: ts, rungs: [{ runId: 'rcasc1' }] }));
  run('rcap1', { branch: 'hub/t3/claude', outcome: 'context' }); run('rcap2', { branch: 'hub/t3/claude', outcome: 'context', handoffOf: 'rcap1' }); run('rcap3', { branch: 'hub/t3/claude', handoffOf: 'rcap2' });
  const c = ctx();
  const mode = async (id: string): Promise<[string, number]> => { const j = (await get(c, id)).json; return [j.handoff, j.limit]; };
  assert.deepEqual(await mode('rown1'), ['restart', 250_000]);
  assert.deepEqual(await mode('rchat1'), ['warn', 250_000], 'a chat in the user\'s own folder only gets a warning');
  assert.deepEqual(await mode('rrev1'), ['warn', 250_000], 'a reviewer is never restarted');
  assert.deepEqual(await mode('rcasc1'), ['warn', 250_000], 'a cascade step is stopped with its card, not restarted');
  assert.deepEqual(await mode('rcap3'), ['warn', 250_000], 'the third session in a row is stopped, no fourth');
  assert.deepEqual(await mode('rcap2'), ['restart', 250_000], 'the second session still may restart (one context stop before it)');
  const off = ctx(mkRuns(0)); assert.deepEqual([(await get(off, 'rown1')).json.handoff, (await get(off, 'rown1')).json.limit], ['off', 0]);
  const low = ctx(mkRuns(120_000)); const j = (await get(low, 'rown1')).json;
  assert.deepEqual([j.handoff, j.limit, j.handoffAt, j.breakdown.handoffAt], ['restart', 120_000, 120_000, 120_000], 'the effective limit, not the constant');
  assert.equal(j.level, 'ok'); db.prepare("UPDATE run_event SET data = ? WHERE run_id = 'rown1' AND seq = 2").run(JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: 129_999, out: 1, context: 130_000 }));
  assert.equal((await get(low, 'rown1')).json.level, 'red', 'red from the limit in force');
  assert.equal((await get(c, 'rown1')).json.level, 'ok', '130K is still fine with the default limit');
  const none = (await get(c, 'rchat1')); assert.ok(none.json.handoff);
});

test('S1: the skills estimate never makes a request wait: the first answer comes at once without it, later ones carry it, and the audit runs once', async () => {
  let runs = 0;
  const skills = createSkillsEstimator({ compute: async () => { runs++; await new Promise((r) => setTimeout(r, 300)); return { claude: 1234, codex: 99 }; }, fingerprint: () => 'same', checkEveryMs: 0 });
  const c = ctx(mkRuns(), skills); run('rsk1', { branch: 'hub/s/claude' });
  let worst = 0; const timed = async (): Promise<any> => { const t = Date.now(); const r = await get(c, 'rsk1'); worst = Math.max(worst, Date.now() - t); return r.json; };
  const first = await timed();
  assert.equal(first.skillsTokens, 0); assert.equal(first.skillsKnown, false, 'not computed yet: said so, not guessed');
  for (let i = 0; i < 20; i++) await timed();
  await new Promise((r) => setTimeout(r, 400));
  const later = await timed();
  assert.equal(later.skillsTokens, 1234); assert.equal(later.skillsKnown, true); assert.equal(later.breakdown.skills > 0 || later.firstCall < 1234, true);
  for (let i = 0; i < 20; i++) await timed();
  assert.equal(runs, 1, 'one audit, however often the gauge polls');
  assert.ok(worst < 100, `no request blocked: worst ${worst} ms`);
});

test('N5: rules are the file the run\'s agent loads: CLAUDE.md for Claude, AGENTS.md for Codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-rules-api-'));
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'c'.repeat(400)); writeFileSync(join(dir, 'AGENTS.md'), 'a'.repeat(8000));
    db.prepare("INSERT INTO run (id, project_id, agent, model, cwd, started_at, outcome) VALUES ('rrc1', 1, 'claude', 'm', ?, ?, 'done'), ('rrx1', 1, 'codex', 'm', ?, ?, 'done')").run(dir, ts, dir, ts);
    for (const id of ['rrc1', 'rrx1']) db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, 1, ts, 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: 50_000, out: 1, context: 50_001 }));
    assert.equal((await get(ctx(), 'rrc1')).json.rulesTokens, 100); assert.equal((await get(ctx(), 'rrx1')).json.rulesTokens, 2000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('N5: a route may add a download header and nothing else: the server\'s own security headers cannot be replaced', () => {
  assert.deepEqual(routeHeaders({ 'content-disposition': 'attachment; filename="trace-rabc.jsonl"', 'content-security-policy': 'default-src *', 'X-Content-Type-Options': 'sniff', 'cache-control': 'public, max-age=999', 'content-type': 'text/html', 'set-cookie': 'a=b', location: 'http://evil' }), { 'content-disposition': 'attachment; filename="trace-rabc.jsonl"' });
  assert.deepEqual(routeHeaders({ 'content-disposition': 'attachment; filename="a"\r\nx-evil: 1' }), {}, 'a header value with a line break is dropped');
  assert.deepEqual(routeHeaders(undefined), {}); assert.deepEqual(routeHeaders({}), {});
});
