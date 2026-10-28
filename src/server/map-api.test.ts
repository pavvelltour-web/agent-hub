import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = mkdtempSync(join(tmpdir(), 'hub-mapapi-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { git } = await import('../run/git.ts');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
const db = openDb(':memory:');
const runs = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false });
const srv = await startServer({ db, runs, review: { available: ['claude', 'codex'] } } as never);
const root = mkdtempSync(join(tmpdir(), 'hub-mapapi-repo-'));
after(async () => { await srv.close(); for (const d of [fake, root, `${root}-worktrees`]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
type Init = { method?: string; body?: unknown; click?: boolean };
const api = async (path: string, init: Init = {}): Promise<{ status: number; json: any }> => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, { method: init.method ?? 'GET', headers: { cookie: `hub_token=${srv.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.click ? { origin: `http://127.0.0.1:${srv.port}`, 'x-hub-user-action': 'click' } : {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const until = async (fn: () => Promise<boolean>, ms = 15000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
git(root, ['init', '-q', '-b', 'main']); writeFileSync(join(root, 'a.txt'), 'a\n');
git(root, ['add', '-A']); git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const pid = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id as number;
const insertRun = (id: string, o: { end?: string | null; sid?: string | null; mode?: string | null } = {}): void => {
  const at = new Date().toISOString();
  db.prepare('INSERT INTO run (id, project_id, agent, model, started_at, ended_at, outcome, session_native_id, prompt, work_mode) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, pid, 'claude', 'claude-sonnet-5-5', at, o.end === undefined ? at : o.end, o.end === null ? null : 'done', o.sid === undefined ? `sess-${id}` : o.sid, `task ${id}`, o.mode ?? null);
};
const ev = (runId: string, seq: number, kind: string, data: Record<string, unknown>): void => { db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(runId, seq, new Date().toISOString(), kind, JSON.stringify({ kind, ...data })); };

test('GET /api/map: needs a known project and a plain run id; answers with the tree of the project', async () => {
  assert.equal((await api('/api/map')).status, 400);
  assert.equal((await api('/api/map?projectId=999')).status, 404);
  assert.equal((await api(`/api/map?projectId=${pid}&root=../x`)).status, 400);
  assert.deepEqual((await api(`/api/map?projectId=${pid}`)).json, { nodes: [], edges: [], truncated: 0 });
  const r = await api('/api/runs', { method: 'POST', body: { projectId: pid, agent: 'claude', prompt: 'say hello' } });
  const id = r.json.run.id as string;
  await until(async () => (await api(`/api/runs/${id}`)).json?.run?.endedAt != null || (await api(`/api/runs/${id}`)).json?.endedAt != null);
  const m = (await api(`/api/map?projectId=${pid}`)).json;
  const n = m.nodes.find((x: any) => x.runId === id);
  assert.ok(n && n.kind === 'orchestrator' && n.goal === 'say hello' && n.messageable === true, JSON.stringify(m));
});

test('GET /api/map adds the native sub-agents and background shells found in a run\'s events', async () => {
  insertRun('rnative'); ev('rnative', 1, 'tool', { id: 'tk1', name: 'Task', summary: '', input: { description: 'Audit the build', subagent_type: 'general-purpose' } }); ev('rnative', 2, 'tool_result', { id: 'tk1', summary: '', body: 'done', lines: 1, truncated: false });
  ev('rnative', 3, 'tool', { id: 'bg1', name: 'Bash', summary: '', input: { command: 'npm run watch', run_in_background: true } });
  const m = (await api(`/api/map?projectId=${pid}&root=rnative`)).json;
  const kinds = Object.fromEntries(m.nodes.map((n: any) => [n.id, n.kind]));
  assert.equal(kinds['sub:rnative:tk1'], 'subagent'); assert.equal(kinds['bg:rnative:bg1'], 'background');
  assert.ok(m.edges.some((e: any) => e.from === 'run:rnative' && e.to === 'sub:rnative:tk1'));
});

test('POST /api/map/message: needs the panel\'s own click, a finished hub run with a session, and short text; it resumes that run', async () => {
  insertRun('rmsg');
  const body = { runId: 'rmsg', text: 'and also the footer' };
  assert.equal((await api('/api/map/message', { method: 'POST', body })).status, 403, 'a cookie alone is not enough');
  for (const [b, st] of [[{ ...body, runId: 'rnope' }, 404], [{ ...body, runId: 'nope' }, 400], [{ ...body, runId: '../x' }, 400], [{ ...body, text: '   ' }, 400], [{ ...body, text: 'x'.repeat(8001) }, 400], [{ runId: 'rmsg' }, 400]] as [unknown, number][]) {
    assert.equal((await api('/api/map/message', { method: 'POST', body: b, click: true })).status, st, JSON.stringify(b).slice(0, 60));
  }
  const ok = await api('/api/map/message', { method: 'POST', body, click: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.run.resumeOf, 'rmsg'); assert.equal(ok.json.run.prompt, 'and also the footer');
});

test('POST /api/map/message refuses what cannot be messaged, with a plain reason, and starts nothing', async () => {
  insertRun('rlive', { end: null }); insertRun('rnosid', { sid: null }); insertRun('rrev', { mode: 'gate-reviewer' });
  const before = (db.prepare('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n;
  const r = async (runId: string) => api('/api/map/message', { method: 'POST', body: { runId, text: 'hi' }, click: true });
  const live = await r('rlive'); assert.equal(live.status, 409); assert.match(live.json.error, /still running/);
  const nosid = await r('rnosid'); assert.equal(nosid.status, 400); assert.match(nosid.json.error, /no session/);
  const rev = await r('rrev'); assert.equal(rev.status, 400); assert.match(rev.json.error, /reviewer/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n, before, 'nothing was started');
});

test('asking the orchestrator about a native node sends the text to the run that owns it, naming the node', async () => {
  insertRun('rparent');
  assert.equal((await api('/api/map/message', { method: 'POST', body: { runId: 'rparent', about: 'sub:rother:tk1', text: 'why?' }, click: true })).status, 400, 'the node must belong to the run');
  assert.equal((await api('/api/map/message', { method: 'POST', body: { runId: 'rparent', about: 'sub:rparent:../x', text: 'why?' }, click: true })).status, 400, 'a plain id only');
  const ok = await api('/api/map/message', { method: 'POST', body: { runId: 'rparent', about: 'sub:rparent:tk1', text: 'why did you stop?' }, click: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(ok.json.run.prompt, /^Regarding your sub-agent "tk1": why did you stop\?$/);
});

test('GET /api/journal previews what would be written into specs/; POST /api/journal/apply needs the click, the shown digest and writes only specs/<task>/steps.md', async () => {
  const { appendStep } = await import('../run/journal.ts');
  const home = runs.home;
  appendStep(home, String(pid), 'T77', { at: new Date().toISOString(), kind: 'start', runId: 'r77', agent: 'claude', model: 'claude-sonnet-5-5', goal: 'Build the export' });
  assert.equal((await api('/api/journal')).status, 400);
  assert.equal((await api(`/api/journal?projectId=${pid}&task=../x`)).status, 400);
  assert.equal((await api('/api/journal?projectId=999&task=T77')).status, 404);
  const pv = (await api(`/api/journal?projectId=${pid}&task=T77`)).json;
  assert.equal(pv.entries.length, 1); assert.match(pv.markdown, /^# Steps/); assert.equal(pv.plan.path, 'specs/T77/steps.md'); assert.equal(pv.plan.action, 'create'); assert.match(pv.plan.digest, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(join(root, 'specs')), false, 'the preview writes nothing');
  const body = { projectId: pid, task: 'T77', digest: pv.plan.digest, approved: true };
  assert.equal((await api('/api/journal/apply', { method: 'POST', body })).status, 403, 'a cookie alone is not enough');
  assert.equal((await api('/api/journal/apply', { method: 'POST', body: { ...body, approved: false }, click: true })).status, 400);
  assert.equal((await api('/api/journal/apply', { method: 'POST', body: { ...body, digest: 'f'.repeat(64) }, click: true })).status, 409, 'the journal changed since it was shown');
  const ok = await api('/api/journal/apply', { method: 'POST', body, click: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.ok(ok.json.backupId);
  assert.match(readFileSync(join(root, 'specs', 'T77', 'steps.md'), 'utf8'), /Build the export/);
  appendStep(home, String(pid), 'T77', { at: new Date().toISOString(), kind: 'end', runId: 'r77', agent: 'claude', model: null, goal: 'Build the export', outcome: 'done' });
  assert.equal((await api('/api/journal/apply', { method: 'POST', body, click: true })).status, 409, 'an old digest no longer applies');
});
