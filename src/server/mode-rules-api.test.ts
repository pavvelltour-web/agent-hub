import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = mkdtempSync(join(tmpdir(), 'hub-mrules-'));
process.env['USERPROFILE'] = fake; process.env['HOME'] = fake; process.env['AGENT_HUB_HOME'] = join(fake, '.agent-hub');
mkdirSync(process.env['AGENT_HUB_HOME'], { recursive: true });
const { startServer } = await import('./server.ts');
const { openDb } = await import('../history/store.ts');
const { RunManager } = await import('../run/runner.ts');
const { git } = await import('../run/git.ts');
const { writeFileSync } = await import('node:fs');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
const db = openDb(':memory:');
const runs = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false });
const srv = await startServer({ db, runs, review: { available: ['claude', 'codex'] } } as never);
const root = mkdtempSync(join(tmpdir(), 'hub-mrules-repo-'));
after(async () => { await srv.close(); for (const d of [fake, root, `${root}-worktrees`]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
const api = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, { method: init.method ?? 'GET', headers: { cookie: `hub_token=${srv.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const until = async (fn: () => Promise<boolean>, ms = 15000): Promise<void> => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };
git(root, ['init', '-q', '-b', 'main']); writeFileSync(join(root, 'a.txt'), 'a\n');
git(root, ['add', '-A']); git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const pid = (await api('/api/projects', { method: 'POST', body: { path: root } })).json.id as number;

test('a run started in a work mode carries that mode\'s rules at the start of its prompt, and the user text at the end', async () => {
  for (const mode of ['chat', 'interview', 'review']) {
    const r = await api('/api/runs', { method: 'POST', body: { projectId: pid, agent: 'claude', prompt: `USER-TEXT-${mode}`, workMode: mode } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.run?.id ?? r.json.id;
    await until(async () => (await api(`/api/runs/${id}`)).json?.run?.endedAt != null || (await api(`/api/runs/${id}`)).json?.endedAt != null);
    const row = (await api(`/api/runs/${id}`)).json;
    const prompt = (row.run ?? row).prompt as string;
    assert.ok(prompt.startsWith(`[mode rules: ${mode}]\n`), `${mode}: ${prompt.slice(0, 60)}`);
    assert.ok(prompt.endsWith(`USER-TEXT-${mode}`), mode);
  }
});

test('an unknown mode is refused and a run without a mode gets no rules block', async () => {
  assert.equal((await api('/api/runs', { method: 'POST', body: { projectId: pid, agent: 'claude', prompt: 'x', workMode: 'nope' } })).status, 400);
  const r = await api('/api/runs', { method: 'POST', body: { projectId: pid, agent: 'claude', prompt: 'PLAIN' } });
  assert.equal(r.status, 200);
  const id = r.json.run?.id ?? r.json.id;
  await until(async () => { const j = (await api(`/api/runs/${id}`)).json; return (j.run ?? j).endedAt != null; });
  const j = (await api(`/api/runs/${id}`)).json;
  assert.equal((j.run ?? j).prompt, 'PLAIN');
});
