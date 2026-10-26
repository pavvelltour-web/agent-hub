import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../history/store.ts';
import { fingerprint } from './types.ts';
import type { Finding, RawFinding, Review, Severity } from './types.ts';
import {
  addFindings, answerFinding, clearHumanApproval, createReview, getReview, listFindings, listReviewsForRun,
  markCleared, postedFingerprints, setHumanApproval, updateReview,
} from './store.ts';

const base = { file: 'src/a.ts', title: 'Null deref', classOfBug: 'null-deref' };
const mkReview = (over: Partial<Omit<Review, 'id'>> = {}): Omit<Review, 'id'> => ({
  runId: 'r1', projectId: 1, baseSha: 'aaa', headSha: 'bbb', effort: 'standard', risk: 'medium', round: 1, state: 'hunting', ...over,
});
const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  lens: 'correctness', file: 'src/a.ts', line: 10, title: 'Null deref', evidence: 'x is undefined here', classOfBug: 'null-deref', category: 'bug', ...over,
});
const stored = (r: RawFinding, severity: Severity = 'important') =>
  ({ ...r, severity, fingerprint: fingerprint(r, `line ${r.line}`), votes: { real: 2, notReal: 0 } });

test('fingerprint ignores the line number and whitespace/line-ending differences', () => {
  const a = fingerprint(base, 'if (x.y) {');
  assert.equal(fingerprint(base, '    if (x.y)   {\r\n'), a);
  assert.equal(fingerprint({ ...base, file: 'src\\a.ts' }, 'if (x.y) {'), a);
});

test('fingerprint differs for another file, another class, another line text', () => {
  const a = fingerprint(base, 'if (x.y) {');
  assert.notEqual(fingerprint({ ...base, file: 'src/b.ts' }, 'if (x.y) {'), a);
  assert.notEqual(fingerprint({ ...base, classOfBug: 'race' }, 'if (x.y) {'), a);
  assert.notEqual(fingerprint(base, 'if (x.z) {'), a);
});

test('fingerprint falls back to the title when the class is absent', () => {
  const noClass = { file: 'src/a.ts', title: 'One' };
  assert.notEqual(fingerprint(noClass, 't'), fingerprint({ ...noClass, title: 'Two' }, 't'));
});

test('a review round-trips with every field and updates partially', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  assert.match(r.id, /^rv[0-9a-z]+$/);
  assert.deepEqual(getReview(db, r.id), r);
  const u = updateReview(db, r.id, { state: 'open', headSha: 'ccc', round: 2, risk: 'high' });
  assert.equal(u.state, 'open'); assert.equal(u.headSha, 'ccc'); assert.equal(u.round, 2); assert.equal(u.risk, 'high'); assert.equal(u.baseSha, 'aaa');
  assert.equal(getReview(db, 'nope'), undefined);
  assert.deepEqual(listReviewsForRun(db, 'r1').map((x) => x.id), [r.id]);
  assert.deepEqual(listReviewsForRun(db, 'other'), []);
});

test('findings round-trip with all fields and filter', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const [f1, f2] = addFindings(db, r.id, 1, [stored(raw()), stored(raw({ line: 20, title: 'Other', classOfBug: undefined }), 'nit')]) as [Finding, Finding];
  assert.match(f1.id, /^fd[0-9a-z]+$/);
  const all = listFindings(db, r.id);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { id: f1.id, fingerprint: f1.fingerprint, reviewId: r.id, round: 1, severity: 'important', lens: 'correctness', file: 'src/a.ts', line: 10, title: 'Null deref', evidence: 'x is undefined here', classOfBug: 'null-deref', votes: { real: 2, notReal: 0 }, answer: 'open' });
  assert.equal(all[1]?.classOfBug, undefined);
  assert.deepEqual(listFindings(db, r.id, { severity: 'nit' }).map((f) => f.id), [f2.id]);
  assert.deepEqual(listFindings(db, r.id, { answer: 'fixed' }), []);
  assert.deepEqual(listFindings(db, r.id, { round: 2 }), []);
});

test('answerFinding refuses open and a missing reason for rejected/intentional', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const f = addFindings(db, r.id, 1, [stored(raw())])[0]!;
  assert.throws(() => answerFinding(db, f.id, 'open' as never), /open/);
  assert.throws(() => answerFinding(db, f.id, 'rejected'), /reason/);
  assert.throws(() => answerFinding(db, f.id, 'intentional', '  '), /reason/);
  assert.throws(() => answerFinding(db, 'nope', 'fixed'), /not found/);
  assert.equal(listFindings(db, r.id)[0]?.answer, 'open');
  assert.equal(answerFinding(db, f.id, 'rejected', 'verified false by hand').answer, 'rejected');
  assert.equal(listFindings(db, r.id)[0]?.reason, 'verified false by hand');
  assert.equal(answerFinding(db, f.id, 'dismissed').answer, 'dismissed');
});

test('markCleared records the clearing sha and marks the finding fixed', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const f = addFindings(db, r.id, 1, [stored(raw())])[0]!;
  const c = markCleared(db, f.id, 'ddd');
  assert.equal(c.clearedBy, 'ddd'); assert.equal(c.answer, 'fixed');
});

test('human approval is stored for a sha with a time and can be cleared', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const s = setHumanApproval(db, r.id, 'bbb');
  assert.equal(s.humanApproval?.sha, 'bbb');
  assert.ok(!Number.isNaN(Date.parse(s.humanApproval!.at)));
  assert.deepEqual(getReview(db, r.id)?.humanApproval, s.humanApproval);
  assert.equal(clearHumanApproval(db, r.id).humanApproval, undefined);
  assert.equal(getReview(db, r.id)?.humanApproval, undefined);
});

test('postedFingerprints returns what was stored for that project only', () => {
  const db = openDb(':memory:');
  const r1 = createReview(db, mkReview({ projectId: 1 }));
  const r2 = createReview(db, mkReview({ projectId: 2, runId: 'r2' }));
  const a = addFindings(db, r1.id, 1, [stored(raw())])[0]!;
  const b = addFindings(db, r2.id, 1, [stored(raw({ file: 'src/z.ts' }))])[0]!;
  assert.deepEqual([...postedFingerprints(db, 1)], [a.fingerprint]);
  assert.deepEqual([...postedFingerprints(db, 2)], [b.fingerprint]);
  assert.equal(postedFingerprints(db, 3).size, 0);
});

test('opening an older database adds the review tables in place and keeps run data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-rv-'));
  const path = join(dir, 'hub.sqlite');
  try {
    let db = openDb(path);
    db.prepare("INSERT INTO run (id, agent, started_at) VALUES ('keep', 'claude', 'now')").run();
    db.exec('DROP TABLE finding; DROP TABLE review;');
    db.close();
    db = openDb(path);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    assert.ok(names.includes('review') && names.includes('finding'));
    assert.equal((db.prepare("SELECT id FROM run WHERE id='keep'").get() as { id: string }).id, 'keep');
    assert.equal(createReview(db, mkReview()).state, 'hunting');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
