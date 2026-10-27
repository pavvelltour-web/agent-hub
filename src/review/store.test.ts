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
  INTERRUPTED, markCleared, markInterruptedReviews, postedFingerprints, repeatFingerprints, setHumanApproval, updateReview,
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
  // An answered finding is closed: it cannot be answered again (was: re-answered as 'dismissed'; ADR-019 now limits answers to open findings).
  assert.throws(() => answerFinding(db, f.id, 'dismissed', 'changed my mind'), /only an open finding/);
  assert.equal(listFindings(db, r.id)[0]?.answer, 'rejected');
});

test('dismissed needs a reason for an important or security finding (not for a nit); a fixed finding cannot be answered', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const [imp, sec, nit, fixed] = addFindings(db, r.id, 1, [stored(raw()), stored(raw({ line: 2, title: 'S' }), 'security'), stored(raw({ line: 3, title: 'N' }), 'nit'), stored(raw({ line: 4, title: 'F' }))]) as [Finding, Finding, Finding, Finding];
  assert.throws(() => answerFinding(db, imp.id, 'dismissed'), /reason/);
  assert.throws(() => answerFinding(db, sec.id, 'dismissed', '   '), /reason/);
  assert.equal(answerFinding(db, imp.id, 'dismissed', 'duplicate of another ticket').answer, 'dismissed');
  assert.equal(answerFinding(db, nit.id, 'dismissed').answer, 'dismissed');
  markCleared(db, fixed.id, 'ddd');
  assert.throws(() => answerFinding(db, fixed.id, 'rejected', 'not a bug'), /only an open finding/);
  assert.equal(listFindings(db, r.id).find((f) => f.id === fixed.id)?.answer, 'fixed');
});

test('repeatFingerprints: only this review, never fixed findings', () => {
  const db = openDb(':memory:');
  const r1 = createReview(db, mkReview()), r2 = createReview(db, mkReview({ runId: 'r2' }));
  const [a, b] = addFindings(db, r1.id, 1, [stored(raw()), stored(raw({ file: 'src/b.ts' }))]) as [Finding, Finding];
  addFindings(db, r2.id, 1, [stored(raw({ file: 'src/c.ts' }))]);
  answerFinding(db, a.id, 'rejected', 'not a bug');
  markCleared(db, b.id, 'ddd');
  assert.deepEqual([...repeatFingerprints(db, r1.id)], [a.fingerprint], 'rejected stays a repeat, fixed does not');
  assert.equal(repeatFingerprints(db, r2.id).has(a.fingerprint), false, 'another review does not see it');
});

test('markInterruptedReviews: a review left mid-round is open with the restart reason; finished ones are untouched', () => {
  const db = openDb(':memory:');
  const mid = createReview(db, mkReview({ state: 'verifying' })), done = createReview(db, mkReview({ state: 'passed' }));
  db.prepare('UPDATE review SET info_json = ? WHERE id = ?').run(JSON.stringify({ completed: 1, reasons: [], checks: [{ name: 'x', ok: true }] }), mid.id);
  assert.equal(markInterruptedReviews(db), 1);
  assert.equal(getReview(db, mid.id)?.state, 'open'); assert.equal(getReview(db, done.id)?.state, 'passed');
  const info = JSON.parse((db.prepare('SELECT info_json FROM review WHERE id = ?').get(mid.id) as { info_json: string }).info_json) as { completed: number; reasons: string[] };
  assert.deepEqual(info.reasons, [INTERRUPTED]); assert.equal(info.completed, 1);
});

test('markCleared records the clearing sha and marks the finding fixed', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const f = addFindings(db, r.id, 1, [stored(raw())])[0]!;
  const c = markCleared(db, f.id, 'ddd');
  assert.equal(c.clearedBy, 'ddd'); assert.equal(c.answer, 'fixed'); assert.equal(c.cleared, true);
});

test('markCleared (E3) never overwrites an answer given meanwhile: only an open finding becomes fixed', () => {
  const db = openDb(':memory:');
  const r = createReview(db, mkReview());
  const f = addFindings(db, r.id, 1, [stored(raw())])[0]!;
  answerFinding(db, f.id, 'rejected', 'not a bug, see the spec');
  const c = markCleared(db, f.id, 'eee');
  assert.equal(c.cleared, false); assert.equal(c.answer, 'rejected'); assert.equal(c.reason, 'not a bug, see the spec'); assert.equal(c.clearedBy, undefined);
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
