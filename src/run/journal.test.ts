import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan } from '../core/plan.ts';
import { JOURNAL_MAX_BYTES, appendStep, planJournalWrite, readJournal, renderSteps, type JournalEntry } from './journal.ts';

const home = mkdtempSync(join(tmpdir(), 'hub-journal-'));
const e = (n: number, o: Partial<JournalEntry> = {}): JournalEntry => ({ at: new Date(Date.UTC(2026, 9, 28, 10, 0, n)).toISOString(), kind: 'start', runId: `r${n}`, agent: 'claude', model: 'claude-sonnet-5-5', goal: `goal ${n}`, ...o });

test('append-only JSONL under <home>/journal/<project>/<task>.jsonl, read back in order', () => {
  appendStep(home, '7', 'T016', e(1)); appendStep(home, '7', 'T016', e(2, { kind: 'end', outcome: 'done' }));
  const file = join(home, 'journal', '7', 'T016.jsonl');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  const j = readJournal(home, '7', 'T016');
  assert.deepEqual(j.entries.map((x) => [x.kind, x.runId, x.outcome]), [['start', 'r1', undefined], ['end', 'r2', 'done']]); assert.equal(j.truncated, false);
  assert.deepEqual(readJournal(home, '7', 'nothing-here'), { entries: [], truncated: false });
});

test('names are plain: a project key or task with a path in it is refused and nothing is written', () => {
  for (const [p, t] of [['..', 'T1'], ['7', '../x'], ['7', 'a/b'], ['7', ''], ['7/8', 'T1'], ['7', 'x'.repeat(80)]]) {
    assert.throws(() => appendStep(home, p as string, t as string, e(1)), /journal name/, `${p} ${t}`);
    assert.throws(() => readJournal(home, p as string, t as string), /journal name/);
  }
  assert.equal(existsSync(join(home, 'journal', '..', 'x.jsonl')), false);
});

test('an entry is redacted, clipped to one line and normalised: junk fields are dropped', () => {
  appendStep(home, '7', 'T017', e(1, { goal: 'fix it\nnow ' + 'g'.repeat(1000) + ' sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', agent: 'claude\u0007' }));
  const got = readJournal(home, '7', 'T017').entries[0]!;
  assert.ok(!got.goal.includes('\n') && !got.goal.includes('sk-ant') && got.goal.length <= 301, String(got.goal.length));
  assert.ok(!/[\u0000-\u001f]/.test(got.agent));
  appendStep(home, '7', 'T017', { ...e(2), kind: 'bogus' as never }); appendStep(home, '7', 'T017', { ...e(3), at: 'not a date' });
  assert.equal(readJournal(home, '7', 'T017').entries.length, 1, 'an unknown kind and a bad time are not recorded');
});

test('the journal stops at 1 MB with one marker and says it was truncated; reading never returns more than asked', () => {
  const big = (n: number): JournalEntry => e(n, { goal: 'x'.repeat(290), runId: `r${n}`.padEnd(60, 'z') });
  const CAP = 3_000;   // the real cap is JOURNAL_MAX_BYTES (1 MB); the parameter keeps this test fast
  for (let i = 0; i < 30; i++) appendStep(home, '7', 'T018', big(i % 55), CAP);
  assert.ok(statSync(join(home, 'journal', '7', 'T018.jsonl')).size <= CAP + 4096);
  assert.equal(JOURNAL_MAX_BYTES, 1_000_000);
  const all = readJournal(home, '7', 'T018', 100000);
  assert.equal(all.truncated, true);
  assert.equal(all.entries.filter((x) => (x.kind as string) === 'truncated').length, 0, 'the marker is not an entry');
  assert.equal(readJournal(home, '7', 'T018', 2).entries.length, 2);
});

test('renderSteps: deterministic Markdown, one line per step, empty journal says so', () => {
  const md = renderSteps([e(1), e(2, { kind: 'end', outcome: 'done', goal: 'goal 1' })]);
  assert.equal(md, ['# Steps', '', '- 2026-10-28T10:00:01.000Z start: claude claude-sonnet-5-5 (run r1): goal 1', '- 2026-10-28T10:00:02.000Z end, done: claude claude-sonnet-5-5 (run r2): goal 1', ''].join('\n'));
  assert.equal(renderSteps([]), '# Steps\n\nNo steps recorded yet.\n');
  assert.equal(renderSteps([e(1)]), renderSteps([e(1)]));
});

test('planJournalWrite: a plan for specs/<task>/steps.md only; it writes nothing; applying it needs approval and leaves a backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-journal-proj-'));
  const plan = planJournalWrite(root, 'T016', [e(1)]);
  assert.equal(plan.root, root); assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0]!.path, join(root, 'specs', 'T016', 'steps.md')); assert.equal(plan.changes[0]!.action, 'create');
  assert.equal(existsSync(join(root, 'specs')), false, 'planning writes nothing');
  assert.throws(() => planJournalWrite(root, '../x', [e(1)]), /journal name/);
  assert.throws(() => applyPlan(plan, { approved: false }));
  const done = applyPlan(plan, { approved: true });
  assert.ok(readFileSync(join(root, 'specs', 'T016', 'steps.md'), 'utf8').startsWith('# Steps')); assert.ok(done.backupId);
  mkdirSync(join(root, 'specs', 'T020'), { recursive: true });
  assert.equal(planJournalWrite(root, 'T016', [e(1), e(2)]).changes[0]!.action, 'update', 'the second time it is an update with the old text as "before"');
});
