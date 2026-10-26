import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = mkdtempSync(join(tmpdir(), 'hub-srv-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
const sk = join(fake, '.agents', 'skills', 'graphify'); mkdirSync(sk, { recursive: true });
writeFileSync(join(sk, 'SKILL.md'), '---\nname: graphify\ndescription: Knowledge graph for agents.\nlicense: MIT\n---\nbody');

const { startServer } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { git } = await import('../run/git.ts');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
const db = openDb(':memory:');
const scenario = { v: 'claude-ok' };
const runs = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe } });
const env = (): void => { runs['opts'].env = { ...process.env, FAKE_SCENARIO: scenario.v }; };
env();
const stub = { picked: null as string | null, opened: [] as string[], loggedIn: false };
const srv = await startServer({ db, runs, agents: () => ({ claude: { installed: true, version: 'fake', path: 'C:/fake/claude.exe' }, codex: { installed: true, version: 'fake', path: 'C:/fake/codex.exe' } }), auth: (id) => ({ loggedIn: id === 'codex' ? true : stub.loggedIn, how: id === 'codex' ? 'ChatGPT' : '' }), native: { pickFolder: () => ({ path: stub.picked }), openLogin: (id) => { stub.opened.push(id); } } });
after(async () => { await srv.close(); });
const base = `http://127.0.0.1:${srv.port}`;
const cookie = `hub_token=${srv.token}`;
const api = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> => {
  const r = await fetch(base + path, { method: init.method ?? 'GET', headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const rawHost = (host: string, path = '/api/state'): Promise<number> => new Promise((res, rej) => { const q = request({ host: '127.0.0.1', port: srv.port, path, headers: { host, cookie } }, (r) => { r.resume(); res(r.statusCode ?? 0); }); q.on('error', rej); q.end(); });
const mkRepo = (): string => { const d = mkdtempSync(join(tmpdir(), 'hub-srvrepo-')); git(d, ['init', '-q', '-b', 'main']); writeFileSync(join(d, 'a.txt'), '1'); git(d, ['add', '-A']); git(d, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i']); return d; };
const until = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 80)); } throw new Error('timeout'); };

test('security: token cookie required, bad Host (DNS rebinding) and bad Origin refused, JSON only, loopback bind', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401, 'no cookie');
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: 'hub_token=nope' } })).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 401, 'the UI itself is also behind the token');
  assert.equal((await fetch(`${base}/?t=wrong`, { redirect: 'manual' })).status, 403);
  const r = await fetch(`${base}/?t=${srv.token}`, { redirect: 'manual' });
  assert.equal(r.status, 302); assert.match(r.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  assert.equal((await api('/api/state')).status, 200);
  assert.equal(await rawHost('evil.example.com'), 403, 'Host header of another site');
  assert.equal(await rawHost(`127.0.0.1:${srv.port + 1}`), 403);
  assert.equal(await rawHost(`localhost:${srv.port}`), 200);
  assert.equal((await api('/api/projects', { method: 'POST', body: { path: tmpdir() }, headers: { origin: 'http://evil.example.com' } })).status, 403);
  const form = await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(form.status, 415);
  const big = await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x'.repeat(1_100_000) }) });
  assert.equal(big.status, 413);
  assert.equal(srv.server.address() && (srv.server.address() as any).address, '127.0.0.1');
  const h = await fetch(`${base}/`, { headers: { cookie } });
  assert.match(h.headers.get('content-security-policy') ?? '', /default-src 'self'/); assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
});

test('static files are confined to web/: traversal and absolute paths cannot read other files', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/..%5c..%5cpackage.json']) {
    const r = await fetch(base + p, { headers: { cookie } });
    const t = await r.text();
    assert.ok(!t.includes('"name": "agent-hub"'), p);
  }
});

test('project: add → init plan (dry run, nothing written) → apply needs approval → undo restores', async () => {
  const root = mkRepo();
  const p = await api('/api/projects', { method: 'POST', body: { path: root } });
  assert.equal(p.status, 200); const id = p.json.id;
  assert.equal((await api('/api/projects', { method: 'POST', body: { path: join(root, 'missing') } })).status, 400);
  const plan = await api('/api/init/plan', { method: 'POST', body: { projectId: id, type: 'automation' } });
  assert.equal(plan.status, 200);
  assert.ok(plan.json.changes.some((c: any) => c.path === 'AGENTS.md') && plan.json.changes.some((c: any) => c.path === '.claude/skills/graphify' && c.action === 'link'));
  assert.ok(!existsSync(join(root, 'AGENTS.md')), 'dry run wrote nothing');
  assert.equal((await api('/api/init/apply', { method: 'POST', body: { projectId: id, type: 'automation' } })).status, 400, 'no approval → refused');
  const ap = await api('/api/init/apply', { method: 'POST', body: { projectId: id, type: 'automation', approved: true } });
  assert.equal(ap.status, 200); assert.ok(ap.json.written >= 5);
  assert.ok(existsSync(join(root, 'AGENTS.md')) && existsSync(join(root, '.claude', 'skills', 'graphify', 'SKILL.md')));
  assert.equal((await api('/api/undo', { method: 'POST', body: { projectId: id, backupId: '../x' } })).status, 400);
  await api('/api/undo', { method: 'POST', body: { projectId: id, backupId: ap.json.backupId } });
  assert.ok(!existsSync(join(root, 'AGENTS.md')));
  const ov = await api(`/api/projects/${id}`);
  assert.equal(ov.json.stages.length, 8); assert.equal(ov.json.stages[0].state, 'current');
  assert.equal((await api('/api/stages/approve', { method: 'POST', body: { projectId: id, stage: 1 } })).status, 400, 'gate refuses without outputs');
});

test('chat run over the API: stream (SSE) delivers events then end; run + events readable afterwards', async () => {
  scenario.v = 'claude-ok'; env();
  const root = mkRepo();
  const id = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  const r = await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'claude', prompt: 'hello', model: 'sonnet' } });
  assert.equal(r.status, 200); const runId = r.json.run.id;
  const sse = await fetch(`${base}/api/runs/${runId}/stream`, { headers: { cookie } });
  const text = await sse.text();
  assert.match(text, /event: ev[\s\S]*"kind":"text"/); assert.match(text, /event: end/);
  const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'ordered, no gaps');
  const got = await api(`/api/runs/${runId}`);
  assert.equal(got.json.run.outcome, 'done'); assert.ok(got.json.events.length >= 6);
  const resumed = await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'claude', prompt: 'more', resumeRunId: runId } });
  assert.equal(resumed.json.run.resumeOf, runId);
  assert.equal((await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'claude', prompt: '' } })).status, 400);
  assert.equal((await api('/api/runs', { method: 'POST', body: { projectId: 9999, prompt: 'x' } })).status, 404);
  assert.equal((await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'gemini', prompt: 'x' } })).status, 400);
});

test('limit → handoff over the API: Codex stops, card appears in the run, Claude continues in the same folder', async () => {
  scenario.v = 'codex-limit'; env();
  const root = mkRepo();
  const id = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  const a = await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'codex', prompt: 'Implement T016', mode: 'task', task: 'T016' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  await until(async () => (await api(`/api/runs/${a.json.run.id}`)).json.card !== null);
  const st = await api(`/api/runs/${a.json.run.id}`);
  assert.equal(st.json.run.outcome, 'limit'); assert.match(st.json.card.markdown, /reason: limit_reached/); assert.ok(st.json.card.resetsAt);
  scenario.v = 'claude-ok'; env();
  const h = await api(`/api/runs/${a.json.run.id}/handoff`, { method: 'POST', body: { agent: 'claude', model: 'sonnet' } });
  assert.equal(h.status, 200); assert.equal(h.json.run.handoffOf, a.json.run.id); assert.equal(h.json.run.cwd, st.json.run.cwd);
  assert.equal((await api(`/api/runs/${h.json.run.id}/handoff`, { method: 'POST', body: { agent: 'codex' } })).status, 400, 'no card on a run that did not hit a limit');
  const logs = await api(`/api/logs?project=${id}`);
  assert.ok(logs.json.some((l: any) => l.source === 'limit') && logs.json.some((l: any) => /handoff card ready/.test(l.message)));
});

test('models: limits (manual + stale), usage, routing; advise cites its rule and switches when Claude is limited', async () => {
  assert.equal((await api('/api/limits', { method: 'POST', body: { agent: 'claude', usedPercent: 140 } })).status, 400);
  await api('/api/limits', { method: 'POST', body: { agent: 'claude', usedPercent: 97 } });
  await api('/api/limits', { method: 'POST', body: { agent: 'codex', usedPercent: 20 } });
  const adv = await api('/api/advise', { method: 'POST', body: { cls: 'implement' } });
  assert.equal(adv.json.choice.agent, 'codex'); assert.equal(adv.json.choice.rule, 'limit:claude→codex');
  assert.ok(adv.json.estimate.tokens.low.cachedIn > 0 && adv.json.estimate.usd === null, 'GPT price unknown → dollars null, not zero');
  assert.equal((await api('/api/advise', { method: 'POST', body: { cls: 'nonsense' } })).status, 400);
  await api('/api/limits', { method: 'POST', body: { agent: 'codex', usedPercent: 10, resetsAt: '2020-01-01T00:00:00Z' } });
  const m = await api('/api/models');
  assert.equal(m.json.agents.find((a: any) => a.id === 'codex').limit.stale, true, 'a limit whose window already reset is stale');
  assert.equal(m.json.agents.find((a: any) => a.id === 'claude').limit.usedPercent, 97);
  assert.equal(m.json.routing.implement.model, 'claude-sonnet-5-5'); assert.equal(m.json.pricesVerifiedAt, '2026-10-22');
});

test('library lists local skills with token cost; scout proposes; diagrams render', async () => {
  const lib = await api('/api/library');
  const g = lib.json.entries.find((e: any) => e.id === 'skill/graphify');
  assert.ok(g.tokenCost > 0 && lib.json.tax.tokensPerTurn >= g.tokenCost);
  assert.equal((await api('/api/skill/skill%2Fgraphify')).json.frontmatter.name, 'graphify');
  assert.equal((await api('/api/skill/mcp%2Fshadcn')).status, 404);
  for (const k of ['arch', 'data', 'stages', 'routing']) assert.ok((await api(`/api/diagram/${k}`)).json.text.length > 50);
  assert.equal((await api('/api/diagram/nope')).status, 404);
  assert.equal((await api('/api/nothing')).status, 404);
});

test('estimate vs actual: a classified run stores its estimate and /api/outcomes compares it with what was used', async () => {
  scenario.v = 'claude-ok'; env();
  const root = mkRepo();
  const id = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  const r = await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'claude', prompt: 'hello', model: 'claude-sonnet-5-5', cls: 'implement' } });
  assert.equal(r.status, 200);
  await until(async () => (await api(`/api/runs/${r.json.run.id}`)).json.run.outcome === 'done');
  const o = await api('/api/outcomes');
  const row = o.json.rows.find((x: any) => x.cls === 'implement' && x.model === 'claude-sonnet-5-5');
  assert.ok(row && row.runs >= 1 && row.done >= 1 && row.withEstimate >= 1 && row.estHighMw > row.estLowMw, JSON.stringify(o.json));
});

test('config: extra skill roots are validated, listed and removable; sparse paths are validated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-root-')); mkdirSync(join(dir, 'zz'), { recursive: true });
  writeFileSync(join(dir, 'zz', 'SKILL.md'), '---\nname: zz-extra\ndescription: Extra skill.\n---\n');
  assert.equal((await api('/api/config/skill-root', { method: 'POST', body: { path: join(dir, 'nope') } })).status, 400);
  assert.equal((await api('/api/config/skill-root', { method: 'POST', body: { path: dir } })).status, 200);
  assert.equal((await api('/api/config')).json.extraSkillRoots.length, 1);
  assert.ok((await api('/api/library')).json.entries.some((e: any) => e.id === 'skill/zz-extra'));
  await api('/api/config/skill-root', { method: 'POST', body: { path: dir, remove: true } });
  assert.equal((await api('/api/config')).json.extraSkillRoots.length, 0);
  const id = (await api('/api/projects', { method: 'POST', body: { path: mkRepo() } })).json.id;
  for (const bad of ['..', '../x', '-rf', 'C:/x', '/etc', 'a/../b']) assert.equal((await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'claude', prompt: 'x', mode: 'task', task: 'S1', sparse: [bad] } })).status, 400, bad);
});

test('plugin profile and install-by-lock over the API: plan is a dry run, apply needs approval', async () => {
  mkdirSync(join(fake, '.claude'), { recursive: true });
  writeFileSync(join(fake, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'firebase@official': true } }));
  const pl = await api('/api/plugins');
  assert.equal(pl.json.claude[0].id, 'firebase@official'); assert.equal(pl.json.claude[0].suggestDisable, true);
  const root = mkRepo();
  const id = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  assert.equal((await api('/api/profile/plan', { method: 'POST', body: { projectId: id, disable: [] } })).status, 400);
  const plan = await api('/api/profile/plan', { method: 'POST', body: { projectId: id, disable: ['firebase@official'] } });
  assert.equal(plan.status, 200); assert.ok(plan.json.changes.some((c: any) => c.path === '.claude/settings.local.json'));
  assert.ok(!existsSync(join(root, '.claude', 'settings.local.json')), 'dry run wrote nothing');
  assert.equal((await api('/api/profile/apply', { method: 'POST', body: { projectId: id, disable: ['firebase@official'] } })).status, 400);
  assert.equal((await api('/api/profile/apply', { method: 'POST', body: { projectId: id, disable: ['firebase@official'], approved: true } })).status, 200);
  assert.ok(existsSync(join(root, '.claude', 'settings.local.json')));
  assert.equal((await api('/api/install/plan', { method: 'POST', body: { projectId: id } })).status, 400, 'no hub.lock.json yet');
  await api('/api/init/apply', { method: 'POST', body: { projectId: id, type: 'automation', approved: true } });
  const inst = await api('/api/install/plan', { method: 'POST', body: { projectId: id } });
  assert.equal(inst.status, 200); assert.ok(inst.json.items.some((i: any) => i.id === 'skill/graphify' && i.status === 'ok'));
  assert.equal((await api('/api/scout/remote?source=nope')).status, 400);
});

test('tools: loading audit per project, skill profile via API, add keeps earlier tools, remove only unlinks, remote ids are validated', async () => {
  mkdirSync(join(fake, '.agents', 'skills', 'zz-extra'), { recursive: true });
  writeFileSync(join(fake, '.agents', 'skills', 'zz-extra', 'SKILL.md'), '---\nname: zz-extra\ndescription: Extra.\n---\n');
  const root = mkRepo();
  const id = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  const l0 = await api(`/api/loading?project=${id}`);
  assert.equal(l0.status, 200); assert.ok(l0.json.rows.some((r: any) => r.name === 'graphify' && r.agent === 'codex' && r.origin === 'user'));
  assert.ok(l0.json.totals.codex.baseline > 0);
  const off = await api('/api/profile/apply', { method: 'POST', body: { projectId: id, skills: { graphify: 'off' }, approved: true } });
  assert.equal(off.status, 200);
  const l1 = await api(`/api/loading?project=${id}`);
  assert.equal(l1.json.rows.find((r: any) => r.name === 'graphify' && r.agent === 'codex').state, 'off'); assert.ok(l1.json.totals.codex.now < l1.json.totals.codex.baseline, 'the profile lowers the per-turn total');
  assert.equal((await api('/api/profile/plan', { method: 'POST', body: { projectId: id, skills: { x: 'bogus' } } })).status, 400, 'unknown state refused');
  assert.equal((await api('/api/profile/plan', { method: 'POST', body: { projectId: id, skills: { '../x': 'off' } } })).status, 400, 'unsafe name refused');
  await api('/api/init/apply', { method: 'POST', body: { projectId: id, type: 'automation', approved: true } });
  await api('/api/init/apply', { method: 'POST', body: { projectId: id, extra: ['skill/zz-extra'], approved: true } });
  const tk = JSON.parse((await import('node:fs')).readFileSync(join(root, 'toolkit.json'), 'utf8'));
  assert.ok(tk.selected.some((s: any) => s.id === 'skill/graphify') && tk.selected.some((s: any) => s.id === 'skill/zz-extra'), 'earlier tools kept when adding another');
  const rm = await api('/api/init/plan', { method: 'POST', body: { projectId: id, remove: ['skill/graphify', 'skill/ponytail'] } });
  assert.ok(rm.json.changes.every((c: any) => c.action !== 'unlink' || /skills\/(graphify|ponytail)$/.test(c.path)));
  assert.equal(rm.json.selected.includes('skill/graphify'), true, 'mandatory tools of the project type cannot be removed');
  assert.equal((await api('/api/remote/preview?id=github/x/y')).status, 502);
});

test('agents and folders: login status per agent, sign-in opens a terminal, folder picker registers a project, cancel does nothing', async () => {
  const st = await api('/api/state');
  assert.equal(st.json.agents.claude.auth.loggedIn, false); assert.equal(st.json.agents.codex.auth.loggedIn, true);
  assert.equal((await api('/api/agents/login', { method: 'POST', body: { agent: 'claude' } })).json.opened, true);
  assert.deepEqual(stub.opened, ['claude']);
  assert.equal((await api('/api/agents/login', { method: 'POST', body: { agent: 'gemini' } })).status, 400);
  assert.equal((await api('/api/projects/pick', { method: 'POST', body: {} })).json.cancelled, true);
  stub.picked = mkRepo();
  const p = await api('/api/projects/pick', { method: 'POST', body: {} });
  assert.ok(p.json.id > 0 && p.json.path === stub.picked);
  assert.ok((await api('/api/projects')).json.some((x: any) => x.id === p.json.id));
  stub.picked = join(fake, '.codex', 'secrets');
  assert.equal((await api('/api/projects/pick', { method: 'POST', body: {} })).status, 400, 'credential folders cannot be added');
});

test('history: a session can be continued with the own memory of the agent (resume), in its project folder', async () => {
  const root = mkRepo();
  const pid = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  const { projectId } = await import('../history/store.ts');
  db.prepare("INSERT INTO session (id, agent, native_id, project_id, title, started_at, source_kind, source_path) VALUES ('claude:abc123', 'claude', 'abc123', ?, 'old chat', '2026-10-01T00:00:00Z', 'claude-jsonl', 'x')").run(projectId(db, root));
  scenario.v = 'claude-ok'; env();
  const r = await api('/api/runs', { method: 'POST', body: { prompt: 'go on', resumeSessionId: 'claude:abc123' } });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.run.agent, 'claude'); assert.equal(r.json.run.resumeOf, 'session:claude:abc123');
  await until(async () => (await api(`/api/runs/${r.json.run.id}`)).json.run.outcome === 'done');
  assert.equal((await api('/api/runs', { method: 'POST', body: { prompt: 'x', resumeSessionId: 'claude:nope' } })).status, 404);
  assert.ok(pid > 0);
});

test('history resume refuses a session id that could be read as a command-line option', async () => {
  const root = mkRepo();
  await api('/api/projects', { method: 'POST', body: { path: root } });
  const { projectId } = await import('../history/store.ts');
  db.prepare("INSERT INTO session (id, agent, native_id, project_id, title, started_at, source_kind, source_path) VALUES ('claude:evil', 'claude', '--dangerously-skip-permissions', ?, 'x', '2026-10-01T00:00:00Z', 'claude-jsonl', 'x')").run(projectId(db, root));
  const r = await api('/api/runs', { method: 'POST', body: { prompt: 'go', resumeSessionId: 'claude:evil' } });
  assert.equal(r.status, 400); assert.match(r.json.error, /unexpected shape/);
});

test('learning loop: rating a finished run, routing preferences, consent gate for sharing cases, overhead endpoint', async () => {
  scenario.v = 'claude-ok'; env();
  const root = mkRepo();
  const id = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id;
  const r = await api('/api/runs', { method: 'POST', body: { projectId: id, agent: 'claude', prompt: 'SECRET-TEXT-123', model: 'sonnet', cls: 'implement' } });
  await until(async () => (await api(`/api/runs/${r.json.run.id}`)).json.run.outcome === 'done');
  assert.equal((await api(`/api/runs/${r.json.run.id}/rating`, { method: 'POST', body: { rating: 5 } })).status, 400);
  assert.equal((await api(`/api/runs/${r.json.run.id}/rating`, { method: 'POST', body: { rating: 2 } })).status, 200);
  assert.equal((await api('/api/runs/nope/rating', { method: 'POST', body: { rating: 2 } })).status, 404);
  assert.equal((await api('/api/routing', { method: 'POST', body: { priceWeight: 99 } })).status, 400);
  assert.equal((await api('/api/routing', { method: 'POST', body: { priceWeight: 2, explore: 0.1 } })).status, 200);
  const rt = await api('/api/routing'); assert.deepEqual([rt.json.priceWeight, rt.json.explore], [2, 0.1]); assert.ok(rt.json.observedRuns >= 1);
  await api('/api/routing', { method: 'POST', body: { priceWeight: 1, explore: 0 } });
  // consent: off by default, export refused, preview always allowed and free of text
  assert.equal((await api('/api/sharing')).json.consent, false);
  assert.equal((await api('/api/cases/export', { method: 'POST', body: {} })).status, 403);
  const pv = await api('/api/cases/preview'); assert.ok(pv.json.count >= 1); assert.ok(!JSON.stringify(pv.json).includes('SECRET-TEXT-123'));
  assert.equal((await api('/api/sharing', { method: 'POST', body: { consent: 'yes' } })).status, 400);
  await api('/api/sharing', { method: 'POST', body: { consent: true } });
  const ex = await api('/api/cases/export', { method: 'POST', body: {} });
  assert.equal(ex.status, 200); assert.ok(ex.json.path.includes('exports') && existsSync(ex.json.path));
  assert.ok(!(await import('node:fs')).readFileSync(ex.json.path, 'utf8').includes('SECRET-TEXT-123'));
  await api('/api/sharing', { method: 'POST', body: { consent: false } });
  assert.equal((await api('/api/cases/export', { method: 'POST', body: {} })).status, 403, 'withdrawing consent stops exports at once');
  assert.ok('claude' in (await api('/api/overhead')).json);
});

test('GET /api/modes/matrix: "not verified" until a probe ran on this CLI version; a different version is not verified again', async () => {
  const empty = await api('/api/modes/matrix');
  assert.equal(empty.status, 200); assert.equal(empty.json.claude.verified, false); assert.equal(empty.json.claude.matrix, null);
  const home = process.env['AGENT_HUB_HOME'] as string; mkdirSync(home, { recursive: true });
  const m = { plan: { read: 'allowed', write: 'denied', shell: 'denied', network: 'denied' }, edit: { read: 'allowed', write: 'allowed', shell: 'allowed', network: 'asked' }, full: { read: 'allowed', write: 'allowed', shell: 'allowed', network: 'allowed' } };
  writeFileSync(join(home, 'modes-matrix.json'), JSON.stringify({ claude: { cliVersion: 'fake', at: '2026-10-26T00:00:00Z', matrix: m }, codex: { cliVersion: 'old', at: '2026-10-26T00:00:00Z', matrix: m } }));
  const r = await api('/api/modes/matrix');
  assert.equal(r.json.claude.verified, true); assert.deepEqual(r.json.claude.matrix, m);
  assert.equal(r.json.codex.verified, false, 'the CLI is now "fake", the matrix was measured on "old"');
});
