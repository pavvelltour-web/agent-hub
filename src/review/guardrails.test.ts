import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ACCEPTED, MIN_FINDINGS, guardrails, reviewWindow } from './guardrails.ts';
import { openDb } from '../history/store.ts';

const w = (accepted: number, reopened: number, findings = 0, rejectedFindings = 0) => ({ accepted, reopened, findings, rejectedFindings });

test('guardrails: calm by default: standard review, human approval from the high tier, nothing to say', () => {
  const g = guardrails(w(20, 0, 40, 0));
  assert.deepEqual([g.reviewEffort, g.humanFromTier, g.why, g.flagReviewer, g.tightened, g.note], ['standard', 'high', null, false, false, null]);
});

test('guardrails: reopened work is judged at the 10 % threshold (more than 10 %, not 10 %)', () => {
  assert.equal(guardrails(w(10, 1)).tightened, false, 'exactly 10 %');
  const g = guardrails(w(10, 2));
  assert.deepEqual([g.reviewEffort, g.humanFromTier, g.tightened], ['deep', 'medium', true]);
  assert.match(g.why ?? '', /вернулись в работу 2 из 10/);
  assert.equal(guardrails(w(100, 10)).tightened, false); assert.equal(guardrails(w(100, 11)).tightened, true);
});

test('guardrails: noise is judged at 40 % of the answered findings; the effort stays, the reviewer is flagged for hub review-eval', () => {
  assert.equal(guardrails(w(0, 0, 10, 4)).flagReviewer, false, 'exactly 40 %');
  const g = guardrails(w(0, 0, 10, 5));
  assert.deepEqual([g.flagReviewer, g.reviewEffort, g.humanFromTier, g.tightened], [true, 'standard', 'high', false]);
  assert.match(g.why ?? '', /hub review-eval/);
  const both = guardrails(w(10, 3, 10, 6));
  assert.deepEqual([both.reviewEffort, both.humanFromTier, both.flagReviewer], ['deep', 'medium', true]);
  assert.match(both.why ?? '', /вернулись[\s\S]*review-eval/);
});

test('guardrails: a few cases are not a rate: under the minimums nothing fires and the note says so', () => {
  assert.equal(MIN_ACCEPTED, 5); assert.equal(MIN_FINDINGS, 10);
  const g = guardrails(w(4, 4, 9, 9));
  assert.deepEqual([g.tightened, g.flagReviewer], [false, false]);
  assert.match(g.note ?? '', /только 4 \(нужно 5\)/); assert.match(g.note ?? '', /только 9 \(нужно 10\)/);
  assert.equal(guardrails(w(5, 1)).tightened, true, 'at the minimum it counts');
});

test('guardrails: hostile counts (NaN, negative, strings, reopened above accepted) never throw and never invent a problem', () => {
  for (const bad of [w(Number.NaN, 5), w(-5, -5, -1, -1), { accepted: '10', reopened: '9', findings: '10', rejectedFindings: '9' } as never, null as never, undefined as never, w(Infinity, Infinity, Infinity, Infinity)]) {
    const g = guardrails(bad);
    assert.equal(g.tightened, false); assert.equal(g.flagReviewer, false); assert.equal(g.reviewEffort, 'standard');
  }
  assert.equal(guardrails(w(10, 50)).why?.includes('10 из 10'), true, 'reopened is capped at accepted');
});

test('reviewWindow: accepted = a branch with a passed review, reopened = a later round that is not passed; findings = answered ones; 14 days', () => {
  const db = openDb(':memory:');
  const now = Date.UTC(2026, 9, 27, 12, 0, 0), day = 86_400_000;
  const run = db.prepare('INSERT INTO run (id, project_id, agent, cwd, branch, started_at) VALUES (?,?,?,?,?,?)');
  const review = db.prepare('INSERT INTO review (id, run_id, project_id, base_sha, head_sha, effort, risk, round, state) VALUES (?,?,?,?,?,?,?,?,?)');
  const finding = db.prepare('INSERT INTO finding (id, fingerprint, review_id, round, severity, lens, file, line, title, evidence, votes_real, votes_not_real, answer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const mk = (id: string, branch: string, ageDays: number, states: string[]): void => { run.run(id, 1, 'claude', '/w', branch, new Date(now - ageDays * day).toISOString()); states.forEach((s, i) => review.run(`rv-${id}-${i}`, id, 1, 'a', 'b', 'standard', 'low', i + 1, s)); };
  mk('r1', 'hub/a/claude', 2, ['open', 'passed']);                 // accepted, stayed accepted
  mk('r2', 'hub/b/claude', 3, ['passed', 'open', 'passed']);        // accepted and re-opened once
  mk('r3', 'hub/c/claude', 4, ['open']);                            // never accepted
  mk('r4', 'hub/d/claude', 20, ['passed', 'open']);                 // too old
  ([['f1', 'rv-r1-1', 'fixed'], ['f2', 'rv-r1-1', 'rejected'], ['f3', 'rv-r2-0', 'rejected'], ['f4', 'rv-r2-0', 'open'], ['f5', 'rv-r4-0', 'rejected']] as [string, string, string][]).forEach(([id, rv, ans]) => finding.run(id, id, rv, 1, 'important', 'correctness', 'a.ts', 1, 't', 'e', 1, 0, ans));
  assert.deepEqual(reviewWindow(db, now), { accepted: 2, reopened: 1, findings: 3, rejectedFindings: 2 });
  assert.deepEqual(reviewWindow(openDb(':memory:'), now), { accepted: 0, reopened: 0, findings: 0, rejectedFindings: 0 });
});
