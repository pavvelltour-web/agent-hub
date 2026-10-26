import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, createWorktree, pushGuardEnv, branchName, isGitRepo, facts } from './git.ts';
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
  assert.equal(rm2.get(b.id)!.outcome, 'done');
  const first = rm2.events(b.id).find((e) => e.kind === 'text')!.data as { text: string };
  assert.match(first.text, /got \d{3,} chars: You are continuing work another coding a/);
  assert.match(b.prompt ?? '', /Handoff card/); assert.ok(!/FAIL hooks[\s\S]*FAIL hooks[\s\S]*FAIL hooks/.test(b.prompt ?? ''), 'no transcript replay');
  assert.ok(existsSync(join(root, '.hub', 'handoffs')) && readFileSync(join(root, '.hub', 'handoffs', readdirName(join(root, '.hub', 'handoffs'))), 'utf8').includes('from: {"agent":"codex"'));
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
