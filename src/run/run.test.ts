import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, checkpoint, createWorktree, pushGuardEnv, branchName, isGitRepo, facts } from './git.ts';
import { RunManager } from './runner.ts';
import { approveRunnerHooks } from './hooks-run.ts';
import { openDb } from '../history/store.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };
const repo = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hub-repo-'));
  git(d, ['init', '-q', '-b', 'main']); writeFileSync(join(d, 'a.txt'), 'one\n');
  git(d, ['add', '-A']); git(d, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  return d;
};
const waitEnd = (rm: RunManager, id: string): Promise<void> => new Promise((res) => { if (!rm.isLive(id)) return setTimeout(res, 150); const un = rm.subscribe(id, (e) => { if (e.kind === 'end') { un(); setTimeout(res, 100); } }); });

test('branchName rejects unsafe names; worktree is created next to the repo on hub/<task>/<agent>', () => {
  assert.equal(branchName('T016', 'claude'), 'hub/T016/claude');
  assert.throws(() => branchName('x; rm -rf', 'claude'));
  assert.throws(() => branchName('T1', '../codex'));
  const r = repo();
  const wt = createWorktree(r, 'T016', 'claude', { sparse: ['src'] });
  assert.ok(wt.path.includes('-worktrees') && existsSync(join(wt.path, '.git')));
  assert.equal(git(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD']).out, 'hub/T016/claude');
  assert.ok(isGitRepo(wt.path));
  assert.throws(() => createWorktree(r, 'T016', 'claude'), /worktree add failed/);
});

test('push guard: git push fails under the guard env even with a reachable remote', () => {
  const r = repo();
  const bare = mkdtempSync(join(tmpdir(), 'hub-bare-')); git(bare, ['init', '-q', '--bare']);
  git(r, ['remote', 'add', 'origin', bare]);
  const guarded = git(r, ['push', 'origin', 'main'], pushGuardEnv(join(r, '.hub')));
  assert.equal(guarded.ok, false); assert.match(guarded.err, /push is disabled/);
  assert.equal(git(r, ['push', 'origin', 'main']).ok, true, 'without the guard the same push works: the guard is what blocks it');
});

test('RunManager chat run: events persisted in order, tokens summed, resume reuses session id, handoff refused without a card', async () => {
  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' } });
  const run = rm.start({ agent: 'claude', prompt: 'hello', projectRoot: root, model: 'sonnet', effort: 'medium' });
  await waitEnd(rm, run.id);
  const done = rm.get(run.id)!;
  assert.equal(done.outcome, 'done'); assert.equal(done.sessionNativeId, 'fake-claude-1'); assert.equal(done.tokensIn, 915); assert.equal(done.tokensOut, 40); assert.equal(done.costUsd, 0.01);
  const kinds = rm.events(run.id).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'end').slice(0, 2), ['session', 'text']); assert.equal(kinds.at(-1), 'end');
  assert.deepEqual(rm.events(run.id).map((e) => e.seq), rm.events(run.id).map((_, i) => i + 1));
  const r2 = rm.start({ agent: 'claude', prompt: 'more', projectRoot: root, resumeRunId: run.id });
  await waitEnd(rm, r2.id);
  assert.throws(() => rm.start({ agent: 'codex', prompt: 'x', projectRoot: root, resumeRunId: run.id }), /handoff to switch/);
  assert.throws(() => rm.handoff(run.id, { agent: 'codex' }), /no handoff card/);
  assert.throws(() => rm.start({ agent: 'claude', prompt: '  ', projectRoot: root }), /empty prompt/);
  assert.throws(() => rm.start({ agent: 'claude', prompt: 'x', projectRoot: join(root, 'missing') }), /not found/);
});

test('LIMIT → handoff card with git facts and checkpoint commit → second agent continues in the SAME worktree from the card', async () => {
  const db = openDb(':memory:'); const root = repo();
  const exe = { claude: fakeExe, codex: fakeExe };
  // Codex works in a worktree, edits a file, hits the usage limit.
  const rm1 = new RunManager(db, { exe, env: { ...process.env, FAKE_SCENARIO: 'codex-limit' } });
  const a = rm1.start({ agent: 'codex', prompt: 'Implement T016 hooks compiler', projectRoot: root, task: 'T016', mode: 'task', model: 'gpt-6.1-sol', effort: 'high' });
  const wtPath = a.cwd!; assert.ok(wtPath.includes('T016-codex'));
  writeFileSync(join(wtPath, 'hooks.ts'), 'export const x = 1;\n');            // unfinished work
  await waitEnd(rm1, a.id);
  const stopped = rm1.get(a.id)!;
  assert.equal(stopped.outcome, 'limit');
  const card = rm1.handoffCard(a.id)!;
  assert.ok(card, 'card written'); assert.equal(card.branch, 'hub/T016/codex');
  assert.match(card.markdown, /reason: limit_reached/); assert.match(card.markdown, /files_changed: \["hooks\.ts"\]/);
  assert.match(card.markdown, /checkpoint_committed: true/); assert.match(card.markdown, /summary_by: deterministic/);
  assert.match(card.markdown, /fix the failing step: FAIL hooks/, 'last failing tool result becomes the next step');
  assert.match(card.markdown, /Implement T016 hooks compiler/);
  assert.equal(git(wtPath, ['status', '--porcelain']).out, '', 'work is checkpointed, nothing lost');
  assert.match(git(wtPath, ['log', '-1', '--format=%s']).out, /checkpoint before handoff/);
  assert.equal(facts(wtPath).dirty, false);
  assert.ok(card.resetsAt, 'reset time recovered from the Codex message');
  // Claude continues. Fake claude echoes prompt length + first chars, so we can prove it received the card, not a transcript.
  const rm2 = new RunManager(db, { exe, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' } });
  const b = rm2.handoff(a.id, { agent: 'claude', model: 'sonnet', effort: 'medium' });
  assert.equal(b.cwd, wtPath, 'same worktree'); assert.equal(b.handoffOf, a.id); assert.equal(b.branch, 'hub/T016/codex');
  await waitEnd(rm2, b.id);
  assert.equal(rm2.get(b.id)!.outcome, 'review', 'work on a task branch ends in review (the gate), not done');
  const first = rm2.events(b.id).find((e) => e.kind === 'text')!.data as { text: string };
  assert.match(first.text, /got \d{3,} chars: You are continuing work another coding a/);
  assert.match(b.prompt ?? '', /Handoff card/); assert.ok(!/FAIL hooks[\s\S]*FAIL hooks[\s\S]*FAIL hooks/.test(b.prompt ?? ''), 'no transcript replay');
  assert.ok(existsSync(join(root, '.hub', 'handoffs')) && readFileSync(join(root, '.hub', 'handoffs', readdirName(join(root, '.hub', 'handoffs'))), 'utf8').includes('from: {"agent":"codex"'));
});
test('a review-gate reviewer that hits a usage limit writes no handoff card (its projectRoot is the task folder) and is not listed', async () => {
  const root = repo(); const neutral = mkdtempSync(join(tmpdir(), 'hub-neutral-')); const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  try {
    const db = openDb(':memory:');
    const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'codex-limit' }, summarize: false, home });
    const r = rm.start({ agent: 'codex', prompt: 'review this diff', projectRoot: root, isolatedCwd: neutral, permission: 'plan' });
    await waitEnd(rm, r.id);
    const done = rm.get(r.id)!;
    assert.equal(done.outcome, 'limit'); assert.equal(done.workMode, 'gate-reviewer');
    assert.equal(rm.handoffCard(r.id), undefined);
    assert.equal(existsSync(join(root, '.hub')), false, 'nothing written into the task folder');
    assert.deepEqual(rm.list().map((x) => x.id), [], 'reviewer runs are not in the run list (chats, tasks)');
  } finally { for (const d of [root, neutral, home]) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
});

test('checkpoint never commits the hub folder .hub/, even when the agent staged it; only .hub changes = nothing to commit', () => {
  const r = repo();
  try {
    mkdirSync(join(r, '.hub', 'handoffs'), { recursive: true });
    writeFileSync(join(r, '.hub', 'handoffs', 'card.md'), 'card\n'); writeFileSync(join(r, '.hub', 'staged.md'), 'x\n');
    git(r, ['add', '.hub/staged.md']);
    const only = checkpoint(r, 'cp');
    assert.equal(only.committed, false); assert.equal(only.note, undefined, 'no "nothing to commit" refusal');
    writeFileSync(join(r, 'work.txt'), 'real work\n');
    const cp = checkpoint(r, 'cp');
    assert.equal(cp.committed, true);
    const files = git(r, ['show', '--name-only', '--format=', 'HEAD']).out.split('\n').filter(Boolean);
    assert.deepEqual(files, ['work.txt']);
    assert.ok(existsSync(join(r, '.hub', 'handoffs', 'card.md')), 'the card stays on disk, uncommitted');
  } finally { rmSync(r, { recursive: true, force: true, maxRetries: 3 }); }
});

test('checkpoint runs no repository hook (F6): a husky pre-commit or post-commit file of the branch is not executed', () => {
  const r = repo(); const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  try {
    const marker = join(home, 'hook-ran.txt').replace(/\\/g, '/');
    mkdirSync(join(r, '.husky'), { recursive: true });
    writeFileSync(join(r, '.husky', 'pre-commit'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    writeFileSync(join(r, '.husky', 'post-commit'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    git(r, ['config', 'core.hooksPath', '.husky']);
    // the hook is real: a plain commit runs it
    writeFileSync(join(r, 'probe.txt'), 'p\n'); git(r, ['add', '-A']); git(r, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'probe']);
    assert.ok(existsSync(marker), 'a plain git commit runs the branch hook');
    rmSync(marker);
    writeFileSync(join(r, 'work.txt'), 'w\n');
    const cp = checkpoint(r, 'cp', { home });
    assert.equal(cp.committed, true, cp.note);
    assert.equal(existsSync(marker), false, 'checkpoint ran no hook');
  } finally { for (const d of [r, home]) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
});

test('checkpoint (E4) commits even when the repository asks for gpg signing with a gpg that does not exist', () => {
  const r = repo(); const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  try {
    git(r, ['config', 'commit.gpgsign', 'true']); git(r, ['config', 'gpg.program', 'no-such-gpg-xyz']); git(r, ['config', 'core.fsmonitor', 'true']);
    writeFileSync(join(r, 'w.txt'), 'w\n');
    assert.equal(git(r, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'x', '--allow-empty']).ok, false, 'a plain commit would fail on signing');
    const cp = checkpoint(r, 'cp', { home });
    assert.equal(cp.committed, true, cp.note); assert.equal(cp.note, undefined);
  } finally { for (const d of [r, home]) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
});

const readdirName = (d: string): string => (readdirSyncSafe(d)[0] as string);
import { readdirSync } from 'node:fs';
const readdirSyncSafe = (d: string): string[] => readdirSync(d);

test('stop ends a live run as "stopped"; server restart marks orphaned runs "interrupted"', async () => {
  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'slow' } });
  const r = rm.start({ agent: 'claude', prompt: 'long', projectRoot: root });
  await new Promise((s) => setTimeout(s, 500));
  assert.equal(rm.stop(r.id), true);
  await waitEnd(rm, r.id);
  assert.equal(rm.get(r.id)!.outcome, 'stopped');
  db.prepare("INSERT INTO run (id, agent, started_at) VALUES ('ghost', 'claude', '2026-01-01')").run();
  new RunManager(db);
  assert.equal(rm.get('ghost')!.outcome, 'interrupted');
  void mkdirSync;
});

test('handoff card in the user\'s OWN working tree never commits on their behalf', async () => {
  const db = openDb(':memory:'); const root = repo();
  const before = git(root, ['rev-parse', 'HEAD']).out;
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'codex-limit' } });
  const a = rm.start({ agent: 'codex', prompt: 'work in place', projectRoot: root });          // chat mode: no worktree
  writeFileSync(join(root, 'wip.txt'), 'unsaved work\n');
  await waitEnd(rm, a.id);
  const card = rm.handoffCard(a.id)!;
  assert.match(card.markdown, /checkpoint_committed: false/); assert.match(card.markdown, /not committed: the agent worked in your own working tree/);
  assert.equal(git(root, ['rev-parse', 'HEAD']).out, before, 'no commit was made on the user\'s branch');
  assert.match(git(root, ['status', '--porcelain']).out, /wip\.txt/, 'work is still there, uncommitted');
  assert.match(card.markdown, /files_changed: \["wip\.txt"\]/);
});

import { modelSummary, parseSummary } from './summarize.ts';

test('model-written summary: strict shape, fallback on garbage, used in the card when available', async () => {
  const good = '{"goal":"G","done":["a"],"stoppedAt":"S","next":["n1"],"open":[]}';
  assert.equal(parseSummary(`here you go: ${good}`)?.goal, 'G');
  for (const bad of ['no json', '{"goal":1}', '{"goal":"G","done":"x","stoppedAt":"S","next":[],"open":[]}', '{broken']) assert.equal(parseSummary(bad), undefined, bad);
  assert.match(parseSummary('{"goal":"key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345","done":[],"stoppedAt":"S","next":[],"open":[]}')!.goal, /REDACTED/, 'secrets in model output are redacted');
  const inp = { runId: 'r1', task: 't', prompt: 'do it', from: { agent: 'codex' }, reason: 'limit_reached' as const, cwd: process.cwd(), events: [] };
  const s = await modelSummary(inp, { exe: fakeExe, env: { ...process.env, FAKE_SCENARIO: 'claude-summary' }, timeoutMs: 15000 });
  assert.deepEqual(s?.next, ['fix path substitution', 'run tests']);
  assert.equal(await modelSummary(inp, { exe: fakeExe, env: { ...process.env, FAKE_SCENARIO: 'claude-login' }, timeoutMs: 15000 }), undefined, 'not logged in → no model summary');

  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'codex-limit' }, summarize: async () => s });
  const a = rm.start({ agent: 'codex', prompt: 'Implement T016', projectRoot: root, task: 'T016', mode: 'task' });
  await waitEnd(rm, a.id);
  const card = rm.handoffCard(a.id)!;
  assert.match(card.markdown, /summary_by: claude-haiku-5-5/); assert.match(card.markdown, /fix path substitution/); assert.match(card.markdown, /task: "T016"/);
});

test('runner hooks (hub.json): run around the session as argv arrays, outcome passed, failure never blocks; none when not configured', async () => {
  const db = openDb(':memory:'); const root = repo();
  const marker = join(root, 'hook-out.txt');
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ hooks: {
    sessionStart: [[process.execPath, '-e', 'process.exit(3)']],
    sessionEnd: [[process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.HUB_OUTCOME + ':' + process.env.HUB_AGENT)`], 'not-an-array'],
  } }));
  const home = mkdtempSync(join(tmpdir(), 'hub-home-'));
  const rm0 = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false, home });
  const u = rm0.start({ agent: 'claude', prompt: 'hi', projectRoot: root }); await waitEnd(rm0, u.id);
  assert.ok(rm0.events(u.id).some((e) => e.kind === 'warn' && /not approved/.test((e.data as any).message)), 'hooks from a hub.json nobody approved are skipped and reported');
  assert.ok(!existsSync(marker), 'unapproved hook did not run');
  approveRunnerHooks(root, home);
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false, home });
  const r = rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root });
  await waitEnd(rm, r.id);
  assert.equal(rm.get(r.id)!.outcome, 'done', 'a failing sessionStart hook did not block the run');
  const warns = rm.events(r.id).filter((e) => e.kind === 'warn').map((e) => (e.data as any).message as string);
  assert.ok(warns.some((m) => /hook sessionStart: .* → exit 3/.test(m)) && warns.some((m) => /hook sessionEnd: .* → ok/.test(m)));
  assert.equal(readFileSync(marker, 'utf8'), 'done:claude');
  writeFileSync(join(root, 'hub.json'), JSON.stringify({ hooks: { sessionStart: [[process.execPath, '-e', 'process.exit(0)']] } }));
  const rm3 = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false, home });
  const c = rm3.start({ agent: 'claude', prompt: 'hi', projectRoot: root }); await waitEnd(rm3, c.id);
  assert.ok(rm3.events(c.id).some((e) => e.kind === 'warn' && /not approved/.test((e.data as any).message)), 'a changed hook list needs a new approval');
  const r2 = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false });
  const plain = repo(); const x = r2.start({ agent: 'claude', prompt: 'hi', projectRoot: plain }); await waitEnd(r2, x.id);
  assert.ok(!r2.events(x.id).some((e) => e.kind === 'warn'));
});

test('permission is stored per run; resume and handoff default to the earlier run\'s permission; a review thread never leaves plan', async () => {
  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false });
  const a = rm.start({ agent: 'claude', prompt: 'think', projectRoot: root, permission: 'plan' });
  await waitEnd(rm, a.id);
  assert.equal(rm.get(a.id)?.permission, 'plan');
  const b = rm.start({ agent: 'claude', prompt: 'more', projectRoot: root, resumeRunId: a.id });
  await waitEnd(rm, b.id);
  assert.equal(rm.get(b.id)?.permission, 'plan', 'resume without a choice keeps the earlier permission');
  const c = rm.start({ agent: 'claude', prompt: 'now do it', projectRoot: root, resumeRunId: a.id, permission: 'edit' });
  await waitEnd(rm, c.id);
  assert.equal(rm.get(c.id)?.permission, 'edit', 'an explicit choice on a plain thread is honoured');
  assert.equal(rm.start({ agent: 'claude', prompt: 'x', projectRoot: root }).permission, 'edit', 'a new run without a choice is edit');
  const r = rm.start({ agent: 'claude', prompt: 'review', projectRoot: root, permission: 'plan', workMode: 'review' });
  await waitEnd(rm, r.id);
  assert.equal(rm.get(r.id)?.workMode, 'review');
  const r2 = rm.start({ agent: 'claude', prompt: 'again', projectRoot: root, resumeRunId: r.id, permission: 'full' });
  await waitEnd(rm, r2.id);
  assert.equal(rm.get(r2.id)?.permission, 'plan', 'a review thread stays read-only even if full is asked');
});

test('resume by native session id inherits permission and work mode from the hub run that owns it; review stays plan; handoff cannot loosen review', async () => {
  const root = repo();
  const mk = (): RunManager => new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false });
  const rm = mk();
  const a = rm.start({ agent: 'claude', prompt: 'think', projectRoot: root, permission: 'plan' });
  await waitEnd(rm, a.id);
  const nid = rm.get(a.id)?.sessionNativeId as string; assert.ok(nid);
  const b = rm.start({ agent: 'claude', prompt: 'go on', projectRoot: root, resumeNativeId: nid });
  await waitEnd(rm, b.id);
  assert.equal(rm.get(b.id)?.permission, 'plan', 'native-id resume keeps the owning run\'s permission');
  const rv = mk();
  const r = rv.start({ agent: 'claude', prompt: 'review', projectRoot: root, permission: 'plan', workMode: 'review' });
  await waitEnd(rv, r.id);
  const r2 = rv.start({ agent: 'claude', prompt: 'again', projectRoot: root, resumeNativeId: rv.get(r.id)?.sessionNativeId as string, permission: 'full' });
  await waitEnd(rv, r2.id);
  assert.equal(rv.get(r2.id)?.permission, 'plan', 'a review thread continued from History stays read-only');
  assert.equal(rv.get(r2.id)?.workMode, 'review');
  assert.equal(rv.start({ agent: 'claude', prompt: 'x', projectRoot: root, workMode: 'review', permission: 'full' }).permission, 'plan', 'workMode review always means plan (handoff passes to.permission)');
});

test('event model v2 in the index: bodies capped, secrets redacted before storing, live partials shown but not stored', async () => {
  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-rich' }, summarize: false });
  const run = rm.start({ agent: 'claude', prompt: 'go', projectRoot: root, worktree: false });
  const live: string[] = [];
  rm.subscribe(run.id, (e) => live.push(e.kind));
  await waitEnd(rm, run.id);
  const raw = (db.prepare('SELECT data FROM run_event WHERE run_id = ?').all(run.id) as { data: string }[]).map((r) => r.data).join('\n');
  assert.ok(!raw.includes('sk-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4'), 'secret never stored');
  const stored = rm.events(run.id);
  assert.ok(!stored.some((e) => e.kind === 'partial'), 'partials are not persisted');
  assert.ok(live.includes('partial'), 'but subscribers see them');
  const res = stored.find((e) => e.kind === 'tool_result')!.data as { body: string; truncated: boolean; lines: number };
  assert.deepEqual([res.body.length, res.truncated, res.lines], [64_000, true, 20_001]);
  assert.ok(stored.every((e) => JSON.stringify(e.data).length < 200_000));
  assert.ok(stored.some((e) => e.kind === 'thinking') && stored.some((e) => e.kind === 'diff'));
});

test('hostile event shapes from a CLI (object name, numeric id, non-numeric cost) are stored as safe strings/numbers', async () => {
  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'fixture:claude-hostile.unverified.jsonl', FAKE_FIXTURE_DELAY: '0' }, summarize: false, home: mkdtempSync(join(tmpdir(), 'hub-home-')) });
  const run = rm.start({ agent: 'claude', prompt: 'x', projectRoot: root });
  await waitEnd(rm, run.id);
  const ev = rm.events(run.id).map((e) => e.data as Record<string, unknown>);
  const tools = ev.filter((e) => e['kind'] === 'tool');
  assert.deepEqual(tools.map((t) => [typeof t['id'], t['name']]), [['string', 'unknown'], ['string', 'unknown']]);
  assert.ok(ev.filter((e) => e['kind'] === 'tool_result').every((e) => typeof e['id'] === 'string'));
  assert.ok(ev.filter((e) => e['kind'] === 'unknown').every((e) => typeof e['type'] === 'string'));
  assert.ok(ev.filter((e) => e['kind'] === 'usage').every((e) => e['costUsd'] === undefined || typeof e['costUsd'] === 'number'));
});

test('hostile numbers and ids from a live CLI (usage objects, object session id, junk limits) cannot crash the hub: the run ends, numbers stay finite', async () => {
  const db = openDb(':memory:'); const root = repo();
  const rm = new RunManager(db, { exe: { claude: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'fixture:claude-hostile2.unverified.jsonl', FAKE_FIXTURE_DELAY: '0' }, summarize: false, home: mkdtempSync(join(tmpdir(), 'hub-home-')) });
  const run = rm.start({ agent: 'claude', prompt: 'x', projectRoot: root });
  await waitEnd(rm, run.id);
  const row = rm.get(run.id)!;
  assert.ok(row.outcome === 'done' || row.outcome === 'failed', `outcome: ${row.outcome}`);
  for (const k of ['tokensIn', 'tokensOut', 'tokensCached', 'costUsd'] as const) assert.ok(row[k] === null || (typeof row[k] === 'number' && Number.isFinite(row[k])), `${k}: ${row[k]}`);
  assert.ok(row.sessionNativeId === null || typeof row.sessionNativeId === 'string');
  assert.ok(row.model === null || typeof row.model === 'string');
  const ev = rm.events(run.id);
  const texts = ev.filter((e) => e.kind === 'text').map((e) => (e.data as { text: string }).text);
  assert.deepEqual(texts, ['before the bad rows', 'after the bad rows'], 'rows after the hostile ones are still stored');
  assert.equal(ev.at(-1)?.kind, 'end');
  const usage = ev.filter((e) => e.kind === 'usage').map((e) => e.data as Record<string, unknown>);
  assert.equal(usage.length, 1);
  for (const u of usage) for (const k of ['uncachedIn', 'cachedIn', 'out']) assert.ok(typeof u[k] === 'number' && Number.isFinite(u[k]), `${k}: ${String(u[k])}`);
  for (const l of ev.filter((e) => e.kind === 'limit').map((e) => e.data as Record<string, unknown>)) assert.ok(l['usedPercent'] === undefined || Number.isFinite(l['usedPercent']));
  const lim = db.prepare('SELECT used_percent AS p, resets_at AS r FROM limit_snapshot').all() as { p: unknown; r: unknown }[];
  assert.ok(lim.every((x) => (x.p === null || Number.isFinite(x.p)) && (x.r === null || Number.isFinite(x.r))));
});

test('RunManager lean tool sets: MCP-naming mode starts strict and the temp file is gone after the run; skill-less modes drop slash commands; an unknown server warns', async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), 'hub-leanhome-')), modes = mkdtempSync(join(tmpdir(), 'hub-leanmodes-')), cap = join(home, 'argv.jsonl');
  try {
    const m = (id: string, over: object): void => writeFileSync(join(modes, `${id}.json`), JSON.stringify({ id, title: id, hint: 'h', permission: 'edit', cls: 'implement', worktree: false, skills: [], review: 'none', ...over }));
    m('chat', { mcp: ['shadcn'] }); m('task', { skills: ['x'], mcp: ['ghost'] });
    const catalog = [{ id: 'mcp/shadcn', kind: 'mcp', title: 's', description: '', source: { type: 'local' }, tags: [], stages: [], projectTypes: ['*'], compat: { claude: 'native', codex: 'native' }, tokenCost: 0, risk: { executesCode: true, network: false, writesOutside: false }, sourceVerified: true, mcp: { command: 'npx', args: ['shadcn@latest', 'mcp'], env: ['SHADCN_TOKEN'] } }] as never;
    process.env['SHADCN_TOKEN'] = 'sk-SHOULDNEVERAPPEAR1234567890';
    const rm = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok', FAKE_ARGV_FILE: cap }, summarize: false, home, lean: { modesDir: modes, catalog, profile: tmpdir() } });
    const go = async (req: object): Promise<string> => { const r = rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root, ...req } as never); await waitEnd(rm, r.id); return r.id; };
    const calls = (): { argv: string[]; mcp: string | null }[] => readFileSync(cap, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; mcp: string | null });

    await go({ workMode: 'chat' });
    const a = calls()[0]!;
    assert.ok(a.argv.includes('--disable-slash-commands') && a.argv.includes('--strict-mcp-config'), a.argv.join(' '));
    assert.deepEqual(Object.keys((JSON.parse(a.mcp as string) as { mcpServers: object }).mcpServers), ['shadcn'], 'the agent saw the file while it ran');
    assert.ok(!(a.mcp as string).includes('SHOULDNEVERAPPEAR') && (a.mcp as string).includes('${SHADCN_TOKEN}'), 'names only');
    assert.deepEqual(existsSync(join(home, 'tmp')) ? readdirSync(join(home, 'tmp')) : [], [], 'the temp MCP file is removed when the run ends');

    const id2 = await go({ workMode: 'task' });
    const b = calls()[1]!;
    assert.ok(b.argv.includes('--strict-mcp-config') && !b.argv.includes('--mcp-config') && !b.argv.includes('--disable-slash-commands'), b.argv.join(' '));
    assert.ok(rm.events(id2).some((e) => e.kind === 'warn' && /MCP: "ghost"/.test((e.data as { message: string }).message)), 'the user is told no MCP started');

    await go({ cls: 'mechanical' });
    assert.deepEqual(calls()[2]!.argv.filter((x) => x.startsWith('--') && /slash|mcp/.test(x)), ['--disable-slash-commands'], 'no mode: the task class decides, as before');

    await go({ workMode: 'chat', isolatedCwd: root });
    assert.ok(!calls()[3]!.argv.some((x) => /slash|mcp/.test(x)), 'a review-gate reviewer is never touched');
  } finally { delete process.env['SHADCN_TOKEN']; rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(modes, { recursive: true, force: true }); }
});

test('RunManager lean: a missing or malformed work mode warns; a throwing start removes the temp MCP file; old temp files are swept at start', async () => {
  const root = repo(), home = mkdtempSync(join(tmpdir(), 'hub-leanhome-')), modes = mkdtempSync(join(tmpdir(), 'hub-leanmodes-'));
  try {
    const catalog = [{ id: 'mcp/shadcn', kind: 'mcp', title: 's', description: '', source: { type: 'local' }, tags: [], stages: [], projectTypes: ['*'], compat: { claude: 'native', codex: 'native' }, tokenCost: 0, risk: { executesCode: true, network: false, writesOutside: false }, sourceVerified: true, mcp: { command: 'npx', args: ['shadcn@latest', 'mcp'] } }] as never;
    writeFileSync(join(modes, 'chat.json'), JSON.stringify({ id: 'chat', title: 'c', hint: 'h', permission: 'edit', cls: 'implement', worktree: false, skills: [], review: 'none', mcp: ['shadcn'] }));
    mkdirSync(join(home, 'tmp'), { recursive: true });
    const old = join(home, 'tmp', 'mcp-0123456789abcdef.json'); writeFileSync(old, '{}'); const t = new Date(Date.now() - 3 * 86_400_000); utimesSync(old, t, t);
    const keep = join(home, 'tmp', 'notes.txt'); writeFileSync(keep, 'x'); utimesSync(keep, t, t);
    const rm = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false, home, lean: { modesDir: modes, catalog, profile: tmpdir() } });
    assert.ok(!existsSync(old) && existsSync(keep), 'a day-old temp MCP file is swept, other files are not');
    const warns = (id: string): string[] => rm.events(id).filter((e) => e.kind === 'warn').map((e) => (e.data as { message: string }).message);

    const r1 = rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root, workMode: 'no-such-mode' }); await waitEnd(rm, r1.id);
    assert.ok(warns(r1.id).some((m) => /work mode "no-such-mode"/.test(m) && /not found/.test(m)), warns(r1.id).join(' | '));
    const r2 = rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root, workMode: 'chat' }); await waitEnd(rm, r2.id);
    assert.ok(!warns(r2.id).some((m) => /work mode/.test(m)), 'a valid mode is silent');
    writeFileSync(join(modes, 'chat.json'), '{ not json');
    const r3 = rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root, workMode: 'chat' }); await waitEnd(rm, r3.id);
    assert.ok(warns(r3.id).some((m) => /work mode "chat"/.test(m) && /unreadable|malformed/.test(m)), warns(r3.id).join(' | '));
    const r4 = rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root }); await waitEnd(rm, r4.id);
    assert.ok(!warns(r4.id).some((m) => /work mode/.test(m)), 'no mode requested: nothing to warn about');

    writeFileSync(join(modes, 'chat.json'), JSON.stringify({ id: 'chat', title: 'c', hint: 'h', permission: 'edit', cls: 'implement', worktree: false, skills: [], review: 'none', mcp: ['shadcn'] }));
    rm.adapters.claude = { ...rm.adapters.claude, args: () => { throw new Error('boom'); } };
    assert.throws(() => rm.start({ agent: 'claude', prompt: 'hi', projectRoot: root, workMode: 'chat' }), /boom/);
    assert.deepEqual(readdirSync(join(home, 'tmp')).filter((f) => f.startsWith('mcp-')), [], 'the temp MCP file does not outlive a start that threw');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); rmSync(modes, { recursive: true, force: true }); }
});

// ── fresh context at the right size (ADR-018) ─────────────────────────────────────────────────────────────────────────────────────────────
const WARN_TEXT = 'контекст большой: начну новую сессию по карточке';
const ctxRun = (env: Record<string, string>, opts: { contextLimit?: number } = {}): { rm: RunManager; db: ReturnType<typeof openDb> } => {
  const db = openDb(':memory:');
  return { db, rm: new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-bigctx', ...env }, summarize: false, home: mkdtempSync(join(tmpdir(), 'hub-home-')), ...opts }) };
};
type ChainRow = { id: string; outcome: string | null; cwd: string | null; branch: string | null; prompt: string | null };
const chain = (db: ReturnType<typeof openDb>, id: string): ChainRow[] => {
  const out: ChainRow[] = []; let cur: string | undefined = id;
  while (cur && out.length < 6) { out.push(db.prepare('SELECT id, outcome, cwd, branch, prompt FROM run WHERE id = ?').get(cur) as unknown as ChainRow); cur = (db.prepare('SELECT id FROM run WHERE handoff_of = ?').get(cur) as { id: string } | undefined)?.id; }
  return out;
};
const waitChain = async (rm: RunManager, db: ReturnType<typeof openDb>, id: string): Promise<ChainRow[]> => {
  for (let i = 0; i < 80; i++) { await waitEnd(rm, id); const c = chain(db, id); if (c.every((r) => r.outcome && !rm.isLive(r.id))) return c; await new Promise((r) => setTimeout(r, 150)); }
  return chain(db, id);
};
const warnsOf = (rm: RunManager, id: string): string[] => rm.events(id).filter((e) => e.kind === 'warn').map((e) => (e.data as { message: string }).message);

test('context past 250K on a task run: the agent is stopped, a handoff card with reason context is written, a fresh session continues in the SAME worktree', async () => {
  const root = repo(); const { rm, db } = ctxRun({});
  try {
    const t0 = Date.now();
    const a = rm.start({ agent: 'claude', prompt: 'Implement the parser', projectRoot: root, task: 'ctx1', mode: 'task' });
    writeFileSync(join(a.cwd!, 'parser.ts'), 'export const p = 1;\n');
    const c = await waitChain(rm, db, a.id);
    assert.ok(Date.now() - t0 < 30_000, 'the over-long run was killed, not waited for (the fake would sleep 60 s)');
    assert.equal(c[0]!.outcome, 'context');
    const warns = warnsOf(rm, a.id);
    assert.equal(warns.filter((w) => w === WARN_TEXT).length, 1, 'warned once, not on every turn above the limit: ' + warns.join(' | '));
    assert.ok(!warns.some((w) => /stopped by user/.test(w)), 'the hub, not the user, stopped it: no misleading message');
    const card = rm.handoffCard(a.id)!;
    assert.ok(card); assert.match(card.markdown, /reason: context/); assert.match(card.markdown, /files_changed: \["parser\.ts"\]/); assert.match(card.markdown, /checkpoint_committed: true/);
    assert.equal(c.length, 2, 'one fresh session was started');
    assert.equal(c[1]!.cwd, a.cwd, 'same worktree'); assert.equal(c[1]!.branch, a.branch);
    assert.match(c[1]!.prompt ?? '', /Handoff card/); assert.match(c[1]!.prompt ?? '', /context grew large/); assert.ok(!/usage limit ended/.test(c[1]!.prompt ?? ''), 'the card prompt says why: not a usage limit');
    assert.equal(c[1]!.outcome, 'review', 'the fresh session finished on the task branch');
    const fresh = rm.events(c[1]!.id).find((e) => e.kind === 'text')!.data as { text: string };
    assert.match(fresh.text, /fresh start/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(`${root}-worktrees`, { recursive: true, force: true }); }
});

test('context watch: below the limit nothing happens; the limit can be raised or switched off; a chat in the user\'s own folder is warned, never stopped', async () => {
  const root = repo();
  try {
    for (const [name, opts] of [['higher limit', { contextLimit: 300_000 }], ['off', { contextLimit: 0 }]] as const) {
      const { rm, db } = ctxRun({ FAKE_BIGCTX_END: '1' }, opts);
      const a = rm.start({ agent: 'claude', prompt: 'task', projectRoot: root, task: 'ctx2' + (name === 'off' ? 'b' : 'a'), mode: 'task' });
      const c = await waitChain(rm, db, a.id);
      assert.equal(c.length, 1, name); assert.equal(c[0]!.outcome, 'review', name);
      assert.ok(!warnsOf(rm, a.id).some((m) => /контекст/.test(m)), name);
    }
    const { rm, db } = ctxRun({ FAKE_BIGCTX_END: '1' });
    const chat = rm.start({ agent: 'claude', prompt: 'just chatting', projectRoot: root });
    const c = await waitChain(rm, db, chat.id);
    assert.equal(c.length, 1, 'no automatic new session for a chat'); assert.equal(c[0]!.outcome, 'done', 'the chat ran to its end');
    const w = warnsOf(rm, chat.id);
    assert.ok(w.some((m) => /контекст большой/.test(m)) && !w.includes(WARN_TEXT), 'warned, with a text that does not promise a new session: ' + w.join(' | '));
    assert.equal(rm.handoffCard(chat.id), undefined, 'no card for a run in the user\'s own folder that was not stopped');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(`${root}-worktrees`, { recursive: true, force: true }); }
});

test('context handover is capped: a task whose fresh sessions keep growing past the limit stops after three sessions instead of looping', async () => {
  const root = repo(); const { rm, db } = ctxRun({ FAKE_BIGCTX_ALWAYS: '1' });
  try {
    const a = rm.start({ agent: 'claude', prompt: 'Huge task', projectRoot: root, task: 'ctx3', mode: 'task' });
    const c = await waitChain(rm, db, a.id);
    assert.deepEqual(c.map((r) => r.outcome), ['context', 'context', 'context']);
    assert.ok(warnsOf(rm, c[2]!.id).some((m) => /три сессии подряд/.test(m)), 'the user is told why it stopped');
    assert.ok(rm.handoffCard(c[2]!.id), 'the last session still leaves a card for a manual continue');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(`${root}-worktrees`, { recursive: true, force: true }); }
});
