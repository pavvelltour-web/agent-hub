import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunManager } from '../run/runner.ts';
import { openDb } from '../history/store.ts';
import { freshRepo, gradeRepo, loadTasks, parsePicks, runBench, runVerify, summarize, type GoldenTask } from './bench.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'fake-agent.mjs');
const fakeExe = { cmd: process.execPath, prefix: [fake] };
const fixture = (name: string): string => {
  const d = mkdtempSync(join(tmpdir(), `hub-fx-${name}-`));
  mkdirSync(join(d, 'sub dir')); writeFileSync(join(d, 'sub dir', 'файл.txt'), 'x\n');   // spaces and Cyrillic must survive the copy
  return d;
};

test('bench: a solved task needs a green verify command; cost per solved task divides total cost by solved count', async () => {
  const tasks: GoldenTask[] = [
    { id: 'ok', cls: 'implement', prompt: 'do it', fixture: fixture('ok'), verify: ['node', '-e', 'process.exit(0)'] },
    { id: 'bad', cls: 'debug', prompt: 'do it', fixture: fixture('bad'), verify: ['node', '-e', 'process.exit(1)'] },
  ];
  const runs = new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env: { ...process.env, FAKE_SCENARIO: 'claude-ok' }, summarize: false });
  const rows = await runBench({ tasks, picks: [{ agent: 'claude', model: 'sonnet', effort: 'high' }], runs, repeat: 1 });
  assert.deepEqual(rows.map((r) => r.solved), [true, false]);
  assert.equal(rows[0]?.costUsd, 0.01);
  assert.deepEqual(rows[0]?.tokens, { uncachedIn: 15, cachedIn: 900, out: 40 }, 'fake claude-ok reports 915 input tokens, 900 of them cached');
  const [s] = summarize(rows);
  assert.equal(s?.pick, 'claude:sonnet:high'); assert.equal(s?.solved, 1);
  assert.equal(s?.costPerSolved, 0.02, 'total cost 0.01 + 0.01 over one solved task');
  assert.equal(s?.pctPerSolved, null, 'no limit data → null, never a guess');
});

test('bench: a failed verify command or a run that never started counts as unsolved; nothing solved → costPerSolved null', async () => {
  const rows = [{ taskId: 't', agent: 'claude', model: 'sonnet', effort: 'high', solved: false, tokens: { uncachedIn: 1, cachedIn: 0, out: 1 }, costUsd: 0.05, limitPct: null, seconds: 1 }];
  const [s] = summarize(rows);
  assert.equal(s?.solved, 0); assert.equal(s?.costPerSolved, null);
});

test('golden tasks: 8 tasks, 2 per class, and every pristine fixture fails its own verify command', () => {
  const tasks = loadTasks(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'golden'));
  assert.equal(tasks.length, 8); assert.equal(new Set(tasks.map((t) => t.id)).size, 8);
  for (const c of ['implement', 'debug', 'review', 'mechanical']) assert.equal(tasks.filter((t) => t.cls === c).length, 2, c);
  for (const t of tasks) assert.equal(gradeRepo(t, freshRepo(t.fixture)), false, `${t.id}: an untouched fixture must not count as solved`);
});

test('parsePicks: model:effort pairs, agent derived from the model; malformed or unsafe picks are refused', () => {
  assert.deepEqual(parsePicks('sonnet:high,gpt-6.1-sol:medium'), [{ agent: 'claude', model: 'sonnet', effort: 'high' }, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }]);
  assert.throws(() => parsePicks('sonnet'), /model:effort/);
  assert.throws(() => parsePicks('sonnet:high;rm -rf'), /model:effort/);
  assert.throws(() => parsePicks(''), /model:effort/);
});

const goldenDir = (fixtures: string[], tasks: unknown[]): string => {
  const d = mkdtempSync(join(tmpdir(), 'hub-golden-'));
  for (const f of fixtures) { mkdirSync(join(d, 'fixtures', f), { recursive: true }); writeFileSync(join(d, 'fixtures', f, 'a.txt'), 'x'); }
  mkdirSync(join(d, 'fixtures-x')); mkdirSync(join(d, 'outside'));
  writeFileSync(join(d, 'tasks.json'), JSON.stringify({ tasks }));
  return d;
};
const gt = (fixture: string): unknown => ({ id: 't', cls: 'implement', prompt: 'p', fixture, verify: ['node', '--test'] });

test('loadTasks: a fixture must stay inside fixtures/ (no .., no absolute path, not the root itself, no junction out)', () => {
  const d = goldenDir(['ok'], [gt('ok')]);
  assert.equal(loadTasks(d).length, 1);
  const bad = ['../fixtures-x', '..\\outside', '.', join(d, 'outside'), 'missing'];
  for (const f of bad) { writeFileSync(join(d, 'tasks.json'), JSON.stringify({ tasks: [gt(f)] })); assert.throws(() => loadTasks(d), /fixture/, f); }
  symlinkSync(join(d, 'outside'), join(d, 'fixtures', 'link'), 'junction');
  writeFileSync(join(d, 'tasks.json'), JSON.stringify({ tasks: [gt('link')] }));
  assert.throws(() => loadTasks(d), /fixture/, 'a junction pointing out of fixtures/');
});

test('grading: deleted or edited tests cannot make a task solved; hidden graders are outside the workspace until grading', () => {
  const fx = mkdtempSync(join(tmpdir(), 'hub-fx-grade-'));
  const spec = (n: number): string => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v } from './lib.js';
test('v is ${n}', () => assert.equal(v, ${n}));
`;
  writeFileSync(join(fx, 'package.json'), '{"type":"module"}'); writeFileSync(join(fx, 'lib.js'), 'export const v = 1;\n'); writeFileSync(join(fx, 'a.test.js'), spec(2));
  mkdirSync(join(fx, 'grader')); writeFileSync(join(fx, 'grader', 'g.test.js'), spec(2));
  const task = { id: 't', cls: 'implement' as const, prompt: 'p', fixture: fx, verify: ['node', '--test'] };
  const repo = freshRepo(fx);
  assert.equal(existsSync(join(repo, 'grader')) || existsSync(join(repo, 'g.test.js')), false, 'the grader is not in the agent workspace');
  rmSync(join(repo, 'a.test.js'));
  assert.equal(gradeRepo(task, repo), false, 'deleting the failing test is not a solution');
  writeFileSync(join(repo, 'a.test.js'), spec(1));
  assert.equal(gradeRepo(task, repo), false, 'rewriting the test to match the bug is not a solution');
  writeFileSync(join(repo, 'lib.js'), 'export const v = 2;\n');
  assert.equal(gradeRepo(task, repo), true, 'a real fix passes');
});

test('summarize: runs that report no cost give costPerSolved null, never 0', () => {
  const row = { taskId: 't', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', solved: true, tokens: { uncachedIn: 1, cachedIn: 0, out: 1 }, costUsd: null, limitPct: null, seconds: 1 };
  assert.equal(summarize([row])[0]?.costPerSolved, null);
});
