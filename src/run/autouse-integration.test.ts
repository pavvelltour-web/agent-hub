import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathKey } from '../lib/paths.ts';
import { git } from './git.ts';
import { RunManager } from './runner.ts';
import { AutoScheduler, approveItem, loadAuto, setEnabled } from './autouse.ts';
import { realAutoDeps } from './autouse-wire.ts';
import { addLimit, openDb, projectId } from '../history/store.ts';

/** The scheduler with its REAL effects (RunManager, the fake agent, a real git repository), a fixed clock for the decision and no timers. */
const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };
const base = mkdtempSync(join(tmpdir(), 'hub-autoint-'));
after(() => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
const repo = join(base, 'repo'), home = join(base, 'home');
mkdirSync(repo); mkdirSync(home);
git(repo, ['init', '-q', '-b', 'main']); writeFileSync(join(repo, 'a.txt'), 'one\n');
git(repo, ['add', '-A']); git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
const waitEnd = async (rm: RunManager, id: string): Promise<void> => { const t = Date.now(); while (rm.isLive(id) && Date.now() - t < 20_000) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 200)); };

function rig() {
  const db = openDb(':memory:');
  const runs = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home, env: { ...process.env, FAKE_SCENARIO: 'claude-trace' } });
  const pid = projectId(db, repo) as number;
  const now = Date.now();
  addLimit(db, { agent: 'codex', ts: new Date(now).toISOString(), windowMinutes: 10080, usedPercent: 30, resetsAt: Math.floor(now / 1000) + 5 * 3600, planType: null, source: 'manual' });
  const sched = new AutoScheduler(realAutoDeps({ db, runs, auth: () => ({ loggedIn: true, how: 'ChatGPT' }), env: {} }));
  return { db, runs, pid, sched, now };
}

test('real effects: an approved review runs as a read-only review thread through the RunManager; an approved test job gets a worktree branch, not the main folder', async () => {
  const { runs, pid, sched, now } = rig();
  setEnabled(home, repo, true, now);
  approveItem(home, { id: 'auaaaaaaaa', kind: 'review-existing', projectId: pid, agent: 'codex', expectedPct: 3, writes: 'none' }, repo, now);
  approveItem(home, { id: 'aubbbbbbbb', kind: 'missing-tests', projectId: pid, agent: 'codex', expectedPct: 3, writes: 'branch' }, repo, now);
  const first = sched.tick();
  assert.equal(first.started.length, 1);
  const r1 = runs.get(first.started[0]!.runId)!;
  assert.equal(r1.permission, 'plan'); assert.equal(r1.workMode, 'review'); assert.equal(r1.branch, null, 'a review does not make a branch and writes nothing');
  assert.equal(pathKey(r1.cwd ?? ''), pathKey(repo));
  await waitEnd(runs, r1.id);
  const second = sched.tick();   // frees the slot (records the finished run) and starts the next one in the same pass
  assert.deepEqual(second.started.map((s) => s.itemId), ['aubbbbbbbb']);
  const r2 = runs.get(second.started[0]!.runId)!;
  assert.match(r2.branch ?? '', /^hub\/auto-tests-aubbbbbbbb\/codex$/); assert.notEqual(pathKey(r2.cwd ?? ''), pathKey(repo), 'new tests are written in a worktree, never in the main folder');
  assert.equal(r2.permission, 'edit');
  await waitEnd(runs, r2.id);
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out, 'main'); assert.equal(git(repo, ['status', '--porcelain']).out, '', 'the main folder is untouched');
  const st = loadAuto(home);
  assert.deepEqual(st.items.map((i) => i.status).sort(), ['finished', 'started']);
});

test('real effects: with the toggle off nothing is started even when an approval is on disk', async () => {
  const { runs, pid, sched, now } = rig();
  setEnabled(home, repo, true, now);
  approveItem(home, { id: 'aucccccccc', kind: 'review-existing', projectId: pid, agent: 'codex', expectedPct: 3, writes: 'none' }, repo, now);
  setEnabled(home, repo, false, now);   // cancels it; and a hand-written "approved" row would still not run without the switch
  const before = runs.list().length;
  const rep = sched.tick();
  assert.equal(rep.started.length, 0); assert.equal(runs.list().length, before);
});
