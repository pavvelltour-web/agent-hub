import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../history/store.ts';
import { bucket, buildCases, bundle, exportCases, installId } from './cases.ts';
import { modelStats, outcomes, runScore } from './econ.ts';
import { createReview } from '../review/store.ts';
import type { Review } from '../review/types.ts';
import { startOverhead } from './overhead.ts';

const SECRET = ['SECRET-PROMPT-XYZ', 'C:/secret/place/proj', 'hub/secret-task/claude', 'boom-secret-error', 'Acme-Client-Project'];
const db = openDb(':memory:');
const add = (id: string, o: Record<string, unknown>): void => {
  db.prepare('INSERT INTO run (id, agent, model, effort, prompt, cwd, branch, started_at, ended_at, outcome, tokens_in, tokens_cached, tokens_out, error, cls, project_type, rating, est_json) VALUES (@id,@agent,@model,@effort,@prompt,@cwd,@branch,@started,@ended,@outcome,@tin,@tc,@tout,@error,@cls,@pt,@rating,@est)')
    .run({ id, agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', prompt: SECRET[0], cwd: SECRET[1], branch: SECRET[2], started: '2026-10-14T10:00:00Z', ended: '2026-10-14T10:07:30Z', outcome: 'done', tin: 123_456, tc: 100_000, tout: 4_321, error: SECRET[3], cls: 'implement', pt: 'web-saas', rating: 2, est: null, ...o } as never);
};
add('r1', {}); add('r2', { rating: 0, outcome: 'failed' }); add('r3', { agent: 'codex', model: 'gpt-6.1-sol', outcome: 'limit', rating: null }); add('r4', { outcome: null as never });

test('cases: only coarse, anonymous facts leave the database: no prompts, paths, branches, errors, project names or exact times', () => {
  const cases = buildCases(db);
  assert.equal(cases.length, 3, 'an unfinished run is not a case');
  const json = JSON.stringify(bundle(cases, mkdtempSync(join(tmpdir(), 'hub-id-'))));
  for (const s of SECRET) assert.ok(!json.includes(s), `leaked: ${s}`);
  assert.ok(!/10:00|10:07/.test(json), 'no exact times');
  const c = cases[0]!;
  assert.deepEqual([c.task, c.projectType, c.model, c.outcome, c.rating, c.minutes], ['implement', 'web-saas', 'claude-sonnet-5-5', 'done', 2, 8]);
  assert.match(c.week, /^2026-W4\d$/);
  assert.notEqual(c.tokens.newIn, 23_456, 'tokens are bucketed, not exact');
});

test('cases: buckets are coarse (4 per decade) and zero stays zero', () => {
  assert.equal(bucket(0), 0); assert.equal(bucket(null), 0);
  assert.equal(bucket(12_345), 10_000); assert.equal(bucket(100_000), 100_000);
  assert.ok(bucket(64_000) < 64_000 && bucket(64_000) > 30_000);
});

test('cases: export needs consent and writes a readable file next to the data, never anywhere else', () => {
  const home = mkdtempSync(join(tmpdir(), 'hub-exp-'));
  assert.throws(() => exportCases(db, false, home), /consent required/);
  assert.ok(!existsSync(join(home, 'exports')));
  const r = exportCases(db, true, home);
  assert.ok(r.path.startsWith(join(home, 'exports'))); assert.equal(r.count, 3);
  const j = JSON.parse(readFileSync(r.path, 'utf8')); assert.equal(j.installId, installId(home)); assert.ok(Array.isArray(j.neverIncluded) && j.neverIncluded.length > 3);
});

test('quality score: a rating wins, "done" without a rating is a weak yes, limit and stop say nothing about the model', () => {
  assert.equal(runScore('done', 2), 1); assert.equal(runScore('failed', 2), 1); assert.equal(runScore('done', 1), 0.5); assert.equal(runScore('done', 0), 0);
  assert.equal(runScore('done', null), 0.5); assert.equal(runScore('failed', null), 0); assert.equal(runScore('limit', null), null); assert.equal(runScore('stopped', null), null);
  const s = modelStats(db);
  assert.deepEqual(s['implement|sonnet'], { n: 2, score: 1 }); assert.equal(s['implement|gpt'], undefined, 'the limit-stopped Codex run is not counted');
});

test('econ: a branch run counts only once its review ends (passed = done, reconsider = failed, else pending); reviewer runs are never counted', () => {
  const d = openDb(':memory:');
  const run = (id: string, outcome: string, cwd: string, mode: string | null = null): void => {
    d.prepare("INSERT INTO run (id, agent, model, prompt, cwd, branch, started_at, ended_at, outcome, cls, work_mode) VALUES (?, 'claude', 'claude-sonnet-5-5', 'p', ?, ?, '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', ?, 'implement', ?)").run(id, cwd, mode ? null : 'hub/t/claude', outcome, mode);
  };
  const rv = (runId: string, state: Review['state']): void => { createReview(d, { runId, projectId: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), effort: 'quick', risk: 'low', round: 1, state }); };
  run('t1', 'review', 'C:/p-worktrees/1'); rv('t1', 'passed');
  run('t2', 'review', 'C:/p-worktrees/2'); rv('t2', 'reconsider');
  run('t3', 'review', 'C:/p-worktrees/3'); rv('t3', 'open');
  run('t4', 'review', 'C:/p-worktrees/4');
  run('g1', 'done', 'C:/tmp/hub-reviewer-x', 'gate-reviewer');
  assert.deepEqual(modelStats(d)['implement|sonnet'], { n: 2, score: 0.5 }, 'passed counts as done (0.5 without a verify), reconsider as failed; pending and reviewer runs are left out');
  const row = outcomes(d).find((o) => o.cls === 'implement')!;
  assert.deepEqual([row.runs, row.done, row.failed, row.pending], [4, 1, 1, 2]);
  assert.equal(buildCases(d).length, 4, 'reviewer runs are not shared cases');
});

test('overhead: the first model call of each finished session is what the agent carries at the start', () => {
  const d = openDb(':memory:');
  for (const [i, tok] of [60_000, 70_000, 65_000].entries()) {
    d.prepare("INSERT INTO session (id, agent, native_id, started_at, source_kind, source_path) VALUES (?, 'claude', ?, '2026-10-01T00:00:00Z', 'x', 'x')").run(`claude:${i}`, `n${i}`);
    d.prepare("INSERT INTO usage_event (session_id, ts, model, uncached_in, cached_in, out_tokens) VALUES (?, 't', 'claude-sonnet-5-5', ?, 0, 5)").run(`claude:${i}`, tok);
    d.prepare("INSERT INTO usage_event (session_id, ts, model, uncached_in, cached_in, out_tokens) VALUES (?, 't2', 'claude-sonnet-5-5', 1, 999999, 5)").run(`claude:${i}`);
  }
  const o = startOverhead(d);
  assert.deepEqual([o.claude.n, o.claude.median], [3, 65_000]); assert.equal(o.codex.n, 0); assert.equal(o.codex.median, null);
});

test('quality evidence order: user rating > verify result > outcome; done without verify is 0.5; limit and stop are no evidence', () => {
  // a rating always wins, over a verify result and over the outcome
  assert.equal(runScore('done', 2, 0), 1); assert.equal(runScore('done', 0, 1), 0); assert.equal(runScore('failed', 1, 1), 0.5);
  // a verify result wins over the outcome, in either direction, also while the review is pending ('review')
  assert.equal(runScore('done', null, 1), 0.9); assert.equal(runScore('done', null, 0), 0.1); assert.equal(runScore('review', null, 1), 0.9); assert.equal(runScore('review', null, 0), 0.1);
  assert.equal(runScore('done', null, true), 0.9); assert.equal(runScore('done', null, false), 0.1);
  assert.ok((runScore('done', null, 1) as number) > (runScore('done', null) as number) && (runScore('done', null) as number) > (runScore('done', null, 0) as number), 'verified pass > unverified done > verified fail');
  // without a verify result the outcome decides: done is a weak yes, failed a no
  assert.equal(runScore('done', null), 0.5); assert.equal(runScore('done', null, null), 0.5); assert.equal(runScore('failed', null), 0);
  assert.equal(runScore('limit', null), null); assert.equal(runScore('stopped', null), null); assert.equal(runScore('interrupted', null), null); assert.equal(runScore('review', null), null); assert.equal(runScore(null, null), null);
});

test('modelStats reads verify_passed: a verified pass scores above unverified done, a red verify below it, a pending branch with a verify counts', () => {
  const d = openDb(':memory:');
  const ins = (id: string, outcome: string, verify: number | null, cwd = 'C:/p-worktrees/' + id): void => {
    d.prepare("INSERT INTO run (id, agent, model, prompt, cwd, branch, started_at, ended_at, outcome, cls, verify_passed) VALUES (?, 'claude', 'claude-sonnet-5-5', 'p', ?, ?, '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', ?, 'implement', ?)").run(id, cwd, `hub/${id}/claude`, outcome, verify);
  };
  ins('a', 'review', 1);       // pending branch, verify green: 0.9
  ins('b', 'review', 0);       // pending branch, verify red: 0.1
  ins('c', 'done', null);      // done, nothing verified: 0.5
  ins('e', 'review', null);    // pending, nothing verified: no evidence
  ins('f', 'limit', null);     // no evidence
  const s = modelStats(d)['implement|sonnet'] as { n: number; score: number };
  assert.equal(s.n, 3); assert.ok(Math.abs(s.score - 1.5) < 1e-9, String(s.score));
  assert.equal(d.prepare('SELECT verify_passed AS v FROM run WHERE id = ?').get('c')?.['v'], null, 'NULL is "no verify ran", not 0');
});

test('migration: an older database gains run.verify_passed in place, its rows stay and read NULL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mig-'));
  try {
    const file = join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE run (id TEXT PRIMARY KEY, agent TEXT NOT NULL, started_at TEXT NOT NULL, outcome TEXT, base_sha TEXT); INSERT INTO run (id, agent, started_at, outcome) VALUES ('r1', 'claude', '2026-10-01T00:00:00Z', 'done');");
    old.close();
    const db = openDb(file);
    assert.ok((db.prepare('PRAGMA table_info(run)').all() as { name: string }[]).some((c) => c.name === 'verify_passed'));
    assert.deepEqual(db.prepare('SELECT id, outcome, verify_passed AS v FROM run').all().map((r) => ({ ...r })), [{ id: 'r1', outcome: 'done', v: null }]);
    db.close(); openDb(file).close();   // opening again is a no-op
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
