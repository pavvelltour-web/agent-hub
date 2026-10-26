import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../history/store.ts';
import { bucket, buildCases, bundle, exportCases, installId } from './cases.ts';
import { modelStats, runScore } from './econ.ts';
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
  assert.equal(runScore('done', null), 0.7); assert.equal(runScore('failed', null), 0); assert.equal(runScore('limit', null), null); assert.equal(runScore('stopped', null), null);
  const s = modelStats(db);
  assert.deepEqual(s['implement|sonnet'], { n: 2, score: 1 }); assert.equal(s['implement|gpt'], undefined, 'the limit-stopped Codex run is not counted');
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
