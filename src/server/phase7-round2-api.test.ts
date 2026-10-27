import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Second review round, routes: B2 (the caps route never launders a forged config), S5 (a reset touches only what was flagged and needs a typed word),
// S1 (switching off or cancelling stops live runs even when the state file is flagged), S4 (the settings check comes before anything is spawned), N4 (a guard run cannot be rated).
const home = mkdtempSync(join(tmpdir(), 'hub-p7r2-'));
process.env['USERPROFILE'] = home; process.env['HOME'] = home; process.env['AGENT_HUB_HOME'] = join(home, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const HOME = process.env['AGENT_HUB_HOME'] as string;
const { startServer } = await import('./server.ts');
const { openDb, projectId, addLimit } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { saveUserConfig, loadUserConfig } = await import('../core/registry.ts');
const { setEnabled, loadAuto, saveAuto, projectKeyOf } = await import('../run/autouse.ts');
const { tamperList } = await import('../run/integrity.ts');
const { AUTO_PROMPT_MARKS } = await import('../run/scheduler.ts');

const db = openDb(':memory:');
const runs = new RunManager(db, { summarize: false, home: HOME });
let authCalls = 0;
const agents = { claude: { installed: true, path: 'claude', version: '1' }, codex: { installed: true, path: 'codex', version: '1' } };
const srv = await startServer({ db, runs, agents: () => agents, auth: () => { authCalls++; return { loggedIn: true, how: 'ChatGPT' }; } } as never);
const root = mkdtempSync(join(tmpdir(), 'hub-p7r2-root-'));
after(async () => { await srv.close(); for (const d of [home, root]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
const cookie = `hub_token=${srv.token}`, origin = `http://127.0.0.1:${srv.port}`;
const click = { origin, 'x-hub-user-action': 'click' };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = click): Promise<{ status: number; json: any }> => {
  const r = await fetch(origin + path, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const get = (p: string) => call('GET', p, undefined, {});
const post = (p: string, b: unknown, h?: Record<string, string>) => call('POST', p, b, h);
const pid = projectId(db, root) as number;

test('B2: tightening a cap never launders a forged config: the forged value is discarded and the response says so', async () => {
  saveUserConfig({ ...loadUserConfig(), guardrails: { enabled: false, runWeighted: 75 } });      // written by something other than the route: no seal
  assert.equal((await get('/api/guardrails')).json.enabled, true, 'the forged config is ignored');
  const r = await post('/api/guardrails', { caps: { stopsN: 3 } });
  assert.equal(r.status, 200); assert.equal(r.json.discarded, true, 'the response says a config that was not the hub\'s was thrown away');
  const saved = loadUserConfig().guardrails as Record<string, unknown>;
  assert.deepEqual(saved, { stopsN: 3 }, 'only what the user just set is stored: no enabled:false, no runWeighted:75');
  const g = (await get('/api/guardrails')).json;
  assert.equal(g.enabled, true); assert.equal(g.caps.runWeighted, 25); assert.equal(g.caps.stopsN, 3);
  const again = await post('/api/guardrails', { caps: { stopsN: 4 } });
  assert.equal(again.json.discarded, undefined, 'a sealed config is not discarded');
});

test('S5: a reset needs the panel, the typed word and flags; it resets only the flagged file, never the caps because autouse was flagged', async () => {
  assert.equal((await post('/api/integrity/reset', { confirm: 'СБРОС' })).status, 200, 'clear the flag the previous test left');
  assert.equal((await post('/api/guardrails', { caps: { chainMax: 5 } })).status, 200);
  setEnabled(HOME, root, true, Date.now());
  writeFileSync(join(HOME, 'autouse.json'), JSON.stringify({ version: 1, projects: {}, items: [], starts: [] }));   // not through the hub
  assert.deepEqual((await get('/api/guardrails')).json.tamper.map((t: { file: string }) => t.file), ['autouse.json']);
  assert.equal((await post('/api/integrity/reset', { confirm: 'СБРОС' }, {})).status, 403, 'no Origin and no header');
  assert.equal((await post('/api/integrity/reset', { confirm: 'СБРОС' }, { origin })).status, 403);
  assert.equal((await post('/api/integrity/reset', {})).status, 400, 'no word');
  assert.equal((await post('/api/integrity/reset', { confirm: 'сброс' })).status, 400, 'the word is exact');
  assert.equal((await post('/api/integrity/reset', { confirm: 'reset' })).status, 400);
  assert.equal((await get('/api/guardrails')).json.tamper.length, 1, 'every refusal left the flag');
  assert.equal((await post('/api/integrity/reset', { confirm: 'СБРОС' })).status, 200);
  const g = (await get('/api/guardrails')).json;
  assert.deepEqual(g.tamper, []); assert.equal(g.caps.chainMax, 5, 'the caps the user set are untouched');
  assert.equal((await post('/api/integrity/reset', { confirm: 'СБРОС' })).status, 400, 'nothing flagged: nothing to reset');
});

test('S1: with the state file flagged, switching off and cancelling still stop a live automatic run found through the run table', async () => {
  const stopped: string[] = [], realStop = runs.stop.bind(runs);
  (runs as unknown as { stop: (id: string) => boolean }).stop = (id: string) => { stopped.push(id); return realStop(id); };
  try {
    setEnabled(HOME, root, true, Date.now());
    db.prepare("INSERT INTO run (id, project_id, agent, prompt, started_at) VALUES ('rautolive1', ?, 'codex', ?, ?)").run(pid, AUTO_PROMPT_MARKS[0] + ' more text', new Date().toISOString());
    db.prepare("INSERT INTO run (id, project_id, agent, prompt, started_at) VALUES ('ruserlive1', ?, 'codex', 'a chat the user started', ?)").run(pid, new Date().toISOString());
    writeFileSync(join(HOME, 'autouse.json'), JSON.stringify({ version: 1, projects: {}, items: [], starts: [] }));      // flagged
    assert.equal(tamperList([HOME]).length, 0); await get('/api/guardrails');
    assert.equal(tamperList([HOME]).length, 1);
    assert.equal((await post('/api/autouse/enable', { projectId: pid, enabled: false })).status, 200);
    assert.deepEqual(stopped, ['rautolive1'], 'the automatic run is stopped, the user\'s own chat is not');
    stopped.length = 0;
    assert.equal((await post('/api/autouse/cancel', { id: 'au00000000' })).status, 200, 'cancel under tamper stops the live automatic runs');
    assert.deepEqual(stopped, ['rautolive1']);
  } finally { (runs as unknown as { stop: unknown }).stop = realStop; db.prepare("DELETE FROM run WHERE id IN ('rautolive1','ruserlive1')").run(); }
});

test('S4: a Claude project with unsafe settings is refused BEFORE anything is spawned (the auth check is not called)', async () => {
  const { projectKeyOf: _k } = await import('../run/autouse.ts'); void _k;
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
  const { resetTamper } = await import('../run/integrity.ts'); resetTamper([HOME], HOME);
  setEnabled(HOME, root, true, Date.now());
  addLimit(db, { agent: 'claude', ts: new Date().toISOString(), windowMinutes: 10080, usedPercent: 30, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600, planType: null, source: 'cli-event' });
  authCalls = 0;
  const r = (await get(`/api/autouse?project=${pid}`)).json.projects[0];
  const why = r.blocked.find((b: { agent: string }) => b.agent === 'claude')?.why ?? '';
  assert.match(why, /enableAllProjectMcpServers/);
  assert.equal(authCalls, 2 - 1, 'only Codex was asked for its login: the Claude folder was refused first');
});

test('N4: a run stopped by the circuit breaker cannot be rated', async () => {
  for (const o of ['guard', 'guard-stop']) {
    db.prepare("INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome) VALUES (?, ?, 'claude', ?, ?, ?)").run(`r${o.replace('-', '')}`, pid, new Date().toISOString(), new Date().toISOString(), o);
    assert.equal((await post('/api/runs/r' + o.replace('-', '') + '/rating', { rating: 2 })).status, 400, o);
  }
  void readFileSync; void loadAuto; void saveAuto; void projectKeyOf;
});
