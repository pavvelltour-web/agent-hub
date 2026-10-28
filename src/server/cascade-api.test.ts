import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = mkdtempSync(join(tmpdir(), 'hub-casc-api-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { git } = await import('../run/git.ts');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
const script = join(fake, 'script.json'), capture = join(fake, 'capture.jsonl');
writeFileSync(script, JSON.stringify([{ write: { 'impl.txt': 'good\n' } }]));
const db = openDb(':memory:');
const runs = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'cascade-script', FAKE_CASCADE_SCRIPT: script, FAKE_CAPTURE_FILE: capture }, summarize: false });
const review = { available: ['claude', 'codex'] as ('claude' | 'codex')[] };
const srv = await startServer({ db, runs, review } as never);
const root = mkdtempSync(join(tmpdir(), 'hub-casc-apirepo-'));
after(async () => { await srv.close(); for (const d of [fake, root, `${root}-worktrees`]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
const cookie = `hub_token=${srv.token}`;
const api = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> => {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, { method: init.method ?? 'GET', headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) })
    .catch((e: Error & { cause?: { code?: string } }) => { throw new Error(`${init.method ?? 'GET'} ${path} failed after ${Date.now() - t0} ms: ${e.cause?.code ?? e.message}`, { cause: e }); });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const until = async (fn: () => Promise<boolean>, ms = 15000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

const must = (args: string[]): void => { const r = git(root, args); if (!r.ok) throw new Error(`test setup: git ${args.join(' ')} failed: ${r.err || '(no stderr: the process did not run)'}`); };
must(['init', '-q', '-b', 'main']);
writeFileSync(join(root, 'check.js'), "const t = require('node:fs').readFileSync('impl.txt', 'utf8').trim(); if (t !== 'good') { console.error('FAIL ' + t); process.exit(1); }\n");
writeFileSync(join(root, 'impl.txt'), 'bad\n');
must(['add', '-A']); must(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const start = (extra: Record<string, unknown>) => api('/api/runs', { method: 'POST', body: { projectId: pid, agent: 'claude', model: 'claude-sonnet-5-5', prompt: 'make impl.txt say good', mode: 'task', task: 'casc', strategy: 'cascade', ...extra } });
const pid = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id as number;

test('POST /api/runs strategy: unknown value refused; cascade needs a verify command, an approved one, and usable agents', async () => {
  assert.equal((await start({ strategy: 'turbo' })).status, 400);
  const none = await start({});
  assert.equal(none.status, 400); assert.match(none.json.error, /no verify command/);
  assert.equal((await start({ verify: 'npm test' })).status, 400, 'a string is not an argv list');
  assert.equal((await start({ verify: ['node', 'check.js'], resumeRunId: 'rabc123' })).status, 400, 'a cascade starts a fresh task');
  const un = await start({ verify: ['node', 'check.js'] });
  assert.equal(un.status, 400); assert.equal(un.json.needsApproval, true); assert.match(un.json.digest, /^[0-9a-f]{64}$/); assert.deepEqual(un.json.plan.checks, [['node', 'check.js']]);
  assert.equal((await api('/api/runs')).json.length, 0, 'nothing started');
  review.available = ['codex'];
  const nu = await start({ verify: ['node', 'check.js'] });
  assert.equal(nu.status, 400); assert.match(nu.json.error, /claude is not usable/);
  review.available = ['claude', 'codex'];
});

test('approve is digest-pinned; once approved the cascade starts, runs and the panel can read its steps', async () => {
  const verify = ['node', 'check.js'];
  assert.equal((await api('/api/verify/approve', { method: 'POST', body: { projectId: pid, verify, digest: 'x'.repeat(64), approved: true } })).status, 409);
  assert.equal((await api('/api/verify/approve', { method: 'POST', body: { projectId: pid, verify, digest: 'x' } })).status, 400, 'approved: true is required');
  const digest = (await start({ verify })).json.digest as string;
  const ap = await api('/api/verify/approve', { method: 'POST', body: { projectId: pid, verify, digest, approved: true } });
  assert.equal(ap.status, 200); assert.equal(ap.json.approved, true);
  const go = await start({ verify });
  assert.equal(go.status, 200, JSON.stringify(go.json)); assert.equal(go.json.cascade, true);
  const id = go.json.run.id as string;
  await until(async () => (await api(`/api/runs/${id}/cascade`)).json.cascade?.status === 'solved');
  const st = (await api(`/api/runs/${id}/cascade`)).json.cascade;
  assert.deepEqual(st.rungs.map((r: any) => [r.role, r.verifyPassed]), [['executor', true]]);
  assert.equal((await api('/api/runs/rnope/cascade')).json.cascade, null);
});
