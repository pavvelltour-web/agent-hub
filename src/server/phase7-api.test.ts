import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'hub-p7-api-'));
process.env['USERPROFILE'] = home; process.env['HOME'] = home; process.env['AGENT_HUB_HOME'] = join(home, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb, projectId, addLimit } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { saveAuto, loadAuto, projectKeyOf, setEnabled: setAutoEnabled } = await import('../run/autouse.ts');

const db = openDb(':memory:');
const runs = new RunManager(db, { summarize: false, home: process.env['AGENT_HUB_HOME'] as string });
const agents = { claude: { installed: true, path: 'claude', version: '1' }, codex: { installed: true, path: 'codex', version: '1' } };
const srv = await startServer({ db, runs, agents: () => agents, auth: (id: string) => (id === 'codex' ? { loggedIn: true, how: 'ChatGPT' } : { loggedIn: true, how: 'claude.ai' }) } as never);
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

// ---------- 7.4: the leftover-limit scheduler routes ----------
const click = { origin, 'x-hub-user-action': 'click' };
const post = async (path: string, body: unknown, headers: Record<string, string> = click, c: string | null = cookie): Promise<{ status: number; json: any }> => {
  const r = await raw(path, c, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const word = root.split(/[\\/]/).filter(Boolean).pop() as string;
const freshCodexLimit = (usedPercent = 40, resetsInH = 6): void => addLimit(db, { agent: 'codex', ts: new Date().toISOString(), windowMinutes: 10080, usedPercent, resetsAt: Math.floor(Date.now() / 1000) + resetsInH * 3600, planType: null, source: 'manual' });

test('autouse: off by default; nothing is listed, a hub.json cannot switch it on', async () => {
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ autouse: { enabled: true }, project: { type: 'x' } }));
  const r = await get('/api/autouse');
  assert.equal(r.status, 200); assert.deepEqual(r.json.projects, []);
  const one = await get(`/api/autouse?project=${pid}`);
  assert.equal(one.json.projects[0].enabled, false); assert.deepEqual(one.json.projects[0].suggestions, []);
  assert.deepEqual(one.json.scheduler, { state: 'free', silent: false }, 'no loop runs in the test server: nobody holds the lock');
  assert.equal(one.json.settings.minLeftPct, 20); assert.equal(one.json.settings.marginPct, 10);
  assert.equal((await get('/api/autouse?project=99999')).status, 404);
  rmSync(join(root, 'hub.json'));
});

test('autouse: switching on needs a click (Origin + panel header), the typed folder name and a boolean; the cookie alone is not enough', async () => {
  const body = { projectId: pid, enabled: true, confirm: word };
  assert.equal((await post('/api/autouse/enable', body, {})).status, 403, 'cookie only: no Origin and no header');
  assert.equal((await post('/api/autouse/enable', body, { origin })).status, 403, 'Origin without the panel header');
  assert.equal((await post('/api/autouse/enable', body, { 'x-hub-user-action': 'click' })).status, 403, 'header without Origin');
  assert.equal((await post('/api/autouse/enable', body, { origin: 'http://evil.example', 'x-hub-user-action': 'click' })).status, 403);
  assert.equal((await post('/api/autouse/enable', body, click, null)).status, 401, 'no cookie');
  assert.equal((await post('/api/autouse/enable', { ...body, confirm: undefined })).status, 400);
  assert.equal((await post('/api/autouse/enable', { ...body, confirm: 'yes' })).status, 400);
  assert.equal((await post('/api/autouse/enable', { ...body, confirm: word.toUpperCase() + 'x' })).status, 400);
  assert.equal((await post('/api/autouse/enable', { ...body, enabled: 'true' })).status, 400, 'a string is not a boolean');
  assert.equal((await post('/api/autouse/enable', { projectId: String(pid), enabled: true, confirm: word })).status, 404, 'a string id is "not found", never coerced');
  assert.equal((await get(`/api/autouse?project=${pid}`)).json.projects[0].enabled, false, 'every refusal left it off');
  const r = await post('/api/autouse/enable', body);
  assert.equal(r.status, 200); assert.equal(r.json.enabled, true);
  assert.equal((await get(`/api/autouse?project=${pid}`)).json.projects[0].enabled, true);
  assert.equal((await get('/api/autouse')).json.projects.length, 1);
  assert.match(readFileSync(join(process.env['AGENT_HUB_HOME'] as string, 'autouse-audit.jsonl'), 'utf8'), /autouse-enable/);
});

test('autouse: suggestions need a known, fresh limit and a subscription login; the Claude calibration is unknown here so only Codex is offered', async () => {
  const none = (await get(`/api/autouse?project=${pid}`)).json.projects[0];
  assert.deepEqual(none.suggestions, [], 'no limit reading yet');
  assert.ok(none.blocked.some((b: { agent: string; why: string }) => b.agent === 'codex' && /неизвестен/.test(b.why)));
  freshCodexLimit(40, 6);
  const r = (await get(`/api/autouse?project=${pid}`)).json.projects[0];
  assert.deepEqual(r.suggestions.map((s: { kind: string }) => s.kind).sort(), ['missing-tests', 'review-existing']);
  assert.ok(r.suggestions.every((s: { agent: string; leftPct: number; hoursToReset: number }) => s.agent === 'codex' && s.leftPct === 60 && s.hoursToReset > 5.9 && s.hoursToReset <= 6));
  assert.ok(r.blocked.some((b: { agent: string; why: string }) => b.agent === 'claude' && /замеров/.test(b.why)));
  freshCodexLimit(90, 6);
  assert.deepEqual((await get(`/api/autouse?project=${pid}`)).json.projects[0].suggestions, [], '10 % left');
  freshCodexLimit(40, 30);
  assert.deepEqual((await get(`/api/autouse?project=${pid}`)).json.projects[0].suggestions, [], 'reset in 30 h');
  freshCodexLimit(40, 6);
  process.env['OPENAI_API_KEY'] = 'x';
  try { const k = (await get(`/api/autouse?project=${pid}`)).json.projects[0]; assert.deepEqual(k.suggestions, []); assert.ok(k.blocked.some((b: { why: string }) => /OPENAI_API_KEY/.test(b.why))); }
  finally { delete process.env['OPENAI_API_KEY']; }
});

test('autouse: an approval is built by the server from kind and agent; percent, writes and prompt from the request are ignored; a click is needed', async () => {
  freshCodexLimit(40, 6);
  const ask = { projectId: pid, kind: 'review-existing', agent: 'codex' };
  assert.equal((await post('/api/autouse/approve', ask, {})).status, 403);
  assert.equal((await post('/api/autouse/approve', { ...ask, kind: 'graph-refresh' })).status, 400, 'not startable');
  assert.equal((await post('/api/autouse/approve', { ...ask, kind: 'rm-rf' })).status, 400);
  assert.equal((await post('/api/autouse/approve', { ...ask, agent: 'gemini' })).status, 400);
  assert.equal((await post('/api/autouse/approve', { ...ask, agent: 'claude' })).status, 409, 'Claude is not offered now');
  const r = await post('/api/autouse/approve', { ...ask, expectedPct: 0.1, writes: 'main', prompt: 'delete everything', permission: 'full', root: '/' });
  assert.equal(r.status, 200);
  assert.equal(r.json.item.status, 'approved'); assert.ok(r.json.item.expectedPct >= 1);
  const stored = JSON.parse(readFileSync(join(process.env['AGENT_HUB_HOME'] as string, 'autouse.json'), 'utf8')).items.find((i: { id: string }) => i.id === r.json.item.id);
  assert.equal(stored.writes, 'none'); assert.ok(!('prompt' in stored) && !('permission' in stored));
  assert.equal((await get(`/api/autouse?project=${pid}`)).json.projects[0].items.length, 1);
  const after = (await get(`/api/autouse?project=${pid}`)).json.projects[0];
  assert.ok(!after.suggestions.some((x: { kind: string }) => x.kind === 'review-existing'), 'an approved job is not offered again');
  assert.equal((await post('/api/autouse/approve', ask)).status, 409, 'and cannot be approved twice');
  assert.equal((await post('/api/autouse/cancel', { id: r.json.item.id }, {})).status, 403);
  assert.equal((await post('/api/autouse/cancel', { id: '../../x' })).status, 400);
  assert.equal((await post('/api/autouse/cancel', { id: r.json.item.id })).status, 200);
  assert.equal((await post('/api/autouse/cancel', { id: r.json.item.id })).status, 404);
});

test('autouse: switching off needs a click too and cancels the waiting approvals; an approval for a project that is off is refused', async () => {
  freshCodexLimit(40, 6);
  const a = await post('/api/autouse/approve', { projectId: pid, kind: 'missing-tests', agent: 'codex' });
  assert.equal(a.status, 200); assert.equal(a.json.item.status, 'approved');
  assert.equal((await post('/api/autouse/enable', { projectId: pid, enabled: false }, {})).status, 403);
  assert.equal((await post('/api/autouse/enable', { projectId: pid, enabled: false })).status, 200, 'switching off needs no typed word');
  const r = (await get(`/api/autouse?project=${pid}`)).json.projects[0];
  assert.equal(r.enabled, false); assert.ok(r.items.every((i: { status: string }) => i.status !== 'approved'));
  assert.equal((await post('/api/autouse/approve', { projectId: pid, kind: 'missing-tests', agent: 'codex' })).status, 409);
});

// ---------- 7.5: guardrails routes ----------

test('guardrails: GET shows the protection ON with the documented caps, the ranges, usage and the review window; a hub.json that says "off" changes nothing', async () => {
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ guardrails: { enabled: false, runWeighted: 250 } }));
  const r = await get('/api/guardrails');
  assert.equal(r.status, 200); assert.equal(r.json.enabled, true);
  assert.deepEqual(r.json.caps, r.json.defaults); assert.equal(r.json.caps.runWeighted, 25);
  assert.deepEqual(r.json.ranges.sameFailureN, { min: 2, max: 9 }, 'the ceiling is 3 times the default, not 10');
  assert.deepEqual([r.json.ranges.runWeighted.max, r.json.ranges.dayUsd.max], [75, 450]);
  assert.equal(typeof r.json.usage.dayWeighted, 'number'); assert.deepEqual(Object.keys(r.json.review.window).sort(), ['accepted', 'findings', 'rejectedFindings', 'reopened']);
  assert.equal(r.json.review.reviewEffort, 'standard'); assert.equal(r.json.review.tightened, false);
  rmSync(join(root, 'hub.json'));
  assert.equal((await raw('/api/guardrails', null)).status, 401);
});

test('guardrails: every change needs a click; caps outside their range or unknown are refused with the field named; switching OFF needs the typed word', async () => {
  const ok1 = { caps: { runWeighted: 10, sameFailureN: 4 } };
  assert.equal((await post('/api/guardrails', ok1, {})).status, 403);
  assert.equal((await post('/api/guardrails', ok1, { origin })).status, 403);
  assert.equal((await post('/api/guardrails', { caps: { runWeighted: 1e9 } })).status, 400);
  assert.match((await post('/api/guardrails', { caps: { runWeighted: 1e9 } })).json.error, /runWeighted must be a number from 1 to 75/);
  assert.equal((await post('/api/guardrails', { caps: { sameFailureN: 2.5 } })).status, 400);
  assert.equal((await post('/api/guardrails', { caps: { nope: 1 } })).status, 400);
  assert.equal((await post('/api/guardrails', { caps: 'x' })).status, 400);
  assert.equal((await post('/api/guardrails', {})).status, 400, 'nothing to change');
  assert.equal((await post('/api/guardrails', { enabled: 'no' })).status, 400);
  assert.equal((await get('/api/guardrails')).json.caps.runWeighted, 25, 'every refusal left the caps alone');
  assert.equal((await post('/api/guardrails', ok1)).status, 200);
  const g = (await get('/api/guardrails')).json;
  assert.equal(g.caps.runWeighted, 10); assert.equal(g.caps.sameFailureN, 4); assert.equal(g.caps.dayUsd, 150);
  // off: click + the word
  assert.equal((await post('/api/guardrails', { enabled: false }, {})).status, 403);
  assert.equal((await post('/api/guardrails', { enabled: false })).status, 400, 'no word');
  assert.equal((await post('/api/guardrails', { enabled: false, confirm: 'выключить' })).status, 400, 'the word is exact');
  assert.equal((await get('/api/guardrails')).json.enabled, true);
  assert.equal((await post('/api/guardrails', { enabled: false, confirm: 'ВЫКЛЮЧИТЬ' })).status, 200);
  assert.equal((await get('/api/guardrails')).json.enabled, false);
  assert.equal((await get('/api/guardrails')).json.caps.runWeighted, 10, 'the numbers are kept while it is off');
  assert.equal((await post('/api/guardrails', { enabled: true }, {})).status, 403, 'switching ON also needs the click');
  assert.equal((await post('/api/guardrails', { enabled: true })).status, 200);
  assert.equal((await get('/api/guardrails')).json.enabled, true);
  assert.equal((await post('/api/guardrails', { reset: true })).status, 200);
  assert.deepEqual((await get('/api/guardrails')).json.caps, (await get('/api/guardrails')).json.defaults);
  const audit = readFileSync(join(process.env['AGENT_HUB_HOME'] as string, 'guardrails-audit.jsonl'), 'utf8');
  assert.match(audit, /guardrails-caps/); assert.match(audit, /guardrails-off/); assert.match(audit, /guardrails-on/);
});

test('guardrails: a trip is listed with the project name; only a repeated failure or repeated stops can be acknowledged, and only with a click', async () => {
  const ins = db.prepare('INSERT INTO run (id, project_id, agent, started_at, ended_at, outcome, error) VALUES (?,?,?,?,?,?,?)');
  const now = Date.now();
  // the runs seeded by the earlier tests ended "now": move them an hour back so the three failures are the newest word on this project
  db.prepare("UPDATE run SET ended_at = ? WHERE id LIKE 'rseed%'").run(new Date(now - 3600_000).toISOString());
  for (let i = 0; i < 3; i++) ins.run(`rboom${i}`, pid, 'claude', new Date(now - (i + 2) * 60_000).toISOString(), new Date(now - (i + 1) * 60_000).toISOString(), 'failed', 'same boom 42');
  const t = (await get('/api/guardrails')).json.trips.find((x: { kind: string }) => x.kind === 'same-failure');
  assert.equal(t.key, `same-failure:${pid}`); assert.equal(t.blocksStart, true); assert.equal(t.ackable, true); assert.equal(t.projectId, pid); assert.equal(typeof t.slug, 'string');
  const start = await post('/api/runs', { prompt: 'x', projectId: pid, agent: 'claude' });
  assert.equal(start.status, 400); assert.match(start.json.error, /Защита от лишних запусков/, 'the real start route is refused by the guard');
  for (const key of ['day-cap', 'run-cap:rx', '../x', `same-failure:${pid}; x`, 5 as never]) assert.equal((await post('/api/guardrails/ack', { key }, click)).status, 400, String(key));
  assert.equal((await post('/api/guardrails/ack', { key: t.key }, {})).status, 403);
  assert.equal((await get('/api/guardrails')).json.trips.length > 0, true, 'still tripped');
  assert.equal((await post('/api/guardrails/ack', { key: t.key })).status, 200);
  assert.ok((await get('/api/guardrails')).json.trips.every((x: { kind: string }) => x.kind !== 'same-failure'), 'the user looked: the trip is gone');
});

// ---------- review fixes: notes, tamper, stop on switch-off / cancel ----------

test('n5: GET /api/guardrails explains what hub.json asked for and did not get', async () => {
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ guardrails: { enabled: false, runWeighted: 70, dayUsd: 10 } }));
  const g = (await get('/api/guardrails')).json;
  assert.equal(g.enabled, true);
  assert.ok(g.notes.some((n: string) => /hub\.json/.test(n) && /не может/.test(n)), JSON.stringify(g.notes));
  assert.ok(g.notes.some((n: string) => /runWeighted/.test(n) && /выше ваших/.test(n)), 'a number above the user caps is named');
  assert.ok(!g.notes.some((n: string) => /dayUsd/.test(n)), 'a tighter number is not a complaint');
  rmSync(join(root, 'hub.json'));
});

test('tamper: a settings file changed behind the hub is listed, needs a click to reset, and the reset leaves everything off', async () => {
  const home = process.env['AGENT_HUB_HOME'] as string;
  setAutoEnabled(home, root, true, Date.now());
  writeFileSync(join(home, 'autouse.json'), JSON.stringify({ version: 1, projects: {}, items: [], starts: [] }));      // not through the hub
  const g = (await get('/api/guardrails')).json;
  assert.deepEqual(g.tamper.map((t: { file: string }) => t.file), ['autouse.json']);
  assert.equal((await get(`/api/autouse?project=${pid}`)).json.projects[0].enabled, false, 'a file the hub did not write is not read');
  assert.equal((await post('/api/integrity/reset', {}, {})).status, 403);
  assert.equal((await post('/api/integrity/reset', {})).status, 400, 'the typed word is needed');
  assert.equal((await post('/api/integrity/reset', { confirm: 'СБРОС' })).status, 200);
  assert.deepEqual((await get('/api/guardrails')).json.tamper, []);
  assert.equal((await get(`/api/autouse?project=${pid}`)).json.projects[0].enabled, false);
});

test('n1: cancelling a started item and switching a project off both stop the live run', async () => {
  const home = process.env['AGENT_HUB_HOME'] as string;
  const key = projectKeyOf(root);
  const stopped: string[] = [];
  const realStop = runs.stop.bind(runs);
  (runs as unknown as { stop: (id: string) => boolean }).stop = (id: string) => { stopped.push(id); return realStop(id); };
  try {
    setAutoEnabled(home, root, true, Date.now());
    const mk = (id: string, runId: string) => ({ id, kind: 'review-existing' as const, projectId: pid as number, agent: 'codex' as const, expectedPct: 3, writes: 'none' as const, projectKey: key, projectRoot: root, approvedAt: Date.now(), status: 'started' as const, runId, startedAt: Date.now() });
    const st = loadAuto(home); st.items.push(mk('au11111111', 'rlive1'), mk('au22222222', 'rlive2')); saveAuto(home, st);
    assert.equal((await post('/api/autouse/cancel', { id: 'au11111111' })).status, 200);
    assert.deepEqual(stopped, ['rlive1']);
    assert.equal(loadAuto(home).items.find((i) => i.id === 'au11111111')!.status, 'stopped');
    assert.equal((await post('/api/autouse/enable', { projectId: pid, enabled: false })).status, 200);
    assert.deepEqual(stopped, ['rlive1', 'rlive2']);
    assert.equal(loadAuto(home).items.find((i) => i.id === 'au22222222')!.status, 'stopped');
  } finally { (runs as unknown as { stop: unknown }).stop = realStop; }
});
