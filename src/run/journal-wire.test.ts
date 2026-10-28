import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, projectId } from '../history/store.ts';
import { git } from './git.ts';
import { readJournal } from './journal.ts';
import { RunManager } from './runner.ts';

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fakeAgent] };
const home = mkdtempSync(join(tmpdir(), 'hub-jwire-home-')), root = mkdtempSync(join(tmpdir(), 'hub-jwire-repo-'));
after(() => { for (const d of [home, root, `${root}-worktrees`]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ } });
git(root, ['init', '-q', '-b', 'main']); writeFileSync(join(root, 'a.txt'), 'a\n'); git(root, ['add', '-A']); git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const db = openDb(':memory:');
const runs = new RunManager(db, { home, exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false, guard: false });
const done = async (id: string): Promise<void> => { for (let i = 0; i < 150; i++) { if (runs.get(id)?.endedAt) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

test('a chat run is journaled: start and end, under the project and "chat"', async () => {
  const r = runs.start({ agent: 'claude', prompt: '[mode rules: chat]\nBe brief.\n[end mode rules]\n\nSay hello', projectRoot: root });
  await done(r.id);
  const pid = String(projectId(db, root));
  const j = readJournal(home, pid, 'chat').entries.filter((e) => e.runId === r.id);
  assert.deepEqual(j.map((e) => [e.kind, e.outcome]), [['start', undefined], ['end', 'done']]);
  assert.equal(j[0]!.goal, 'Say hello', 'the user\'s words, not the rules block'); assert.equal(j[0]!.agent, 'claude');
});

test('a task run in a hub branch is journaled under its task; a reviewer run is a "spawn" for the run it reviews and has no "end"', async () => {
  const t = runs.start({ agent: 'claude', prompt: 'Do T9', projectRoot: root, task: 'T9', worktree: true });
  await done(t.id);
  assert.deepEqual(readJournal(home, String(projectId(db, root)), 'T9').entries.map((e) => e.kind), ['start', 'end']);
  const rev = runs.start({ agent: 'claude', prompt: 'review it', projectRoot: root, isolatedCwd: mkdtempSync(join(tmpdir(), 'hub-jwire-iso-')), parentRunId: t.id, spawnReason: 'review hunter' });
  await done(rev.id);
  const e = readJournal(home, String(projectId(db, root)), 'chat').entries.filter((x) => x.runId === rev.id);
  assert.deepEqual(e.map((x) => x.kind), ['spawn']); assert.equal(e[0]!.goal, `review hunter for run ${t.id}`);
});

test('setVerified adds a verify step with the outcome', async () => {
  const r = runs.start({ agent: 'claude', prompt: 'verify me', projectRoot: root });
  await done(r.id); runs.setVerified(r.id, false);
  assert.deepEqual(readJournal(home, String(projectId(db, root)), 'chat').entries.filter((e) => e.runId === r.id).map((e) => [e.kind, e.outcome]), [['start', undefined], ['end', 'done'], ['verify', 'failed']]);
});
