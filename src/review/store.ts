import { randomBytes } from 'node:crypto';
import type { Db } from '../history/store.ts';
import { tx } from '../history/store.ts';
import type { Answer, Finding, Review, Severity, VerifiedFinding } from './types.ts';

const newId = (prefix: 'rv' | 'fd'): string => `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

interface ReviewRow { id: string; run_id: string; project_id: number; base_sha: string; head_sha: string; effort: Review['effort']; risk: Review['risk']; round: number; state: Review['state']; approval_sha: string | null; approval_at: string | null }
interface FindingRow { id: string; fingerprint: string; review_id: string; round: number; severity: Severity; lens: string; file: string; line: number; title: string; evidence: string; class_of_bug: string | null; votes_real: number; votes_not_real: number; answer: Answer; reason: string | null; cleared_by: string | null }

const toReview = (r: ReviewRow): Review => ({
  id: r.id, runId: r.run_id, projectId: r.project_id, baseSha: r.base_sha, headSha: r.head_sha, effort: r.effort, risk: r.risk, round: r.round, state: r.state,
  ...(r.approval_sha && r.approval_at ? { humanApproval: { sha: r.approval_sha, at: r.approval_at } } : {}),
});
const toFinding = (r: FindingRow): Finding => ({
  id: r.id, fingerprint: r.fingerprint, reviewId: r.review_id, round: r.round, severity: r.severity, lens: r.lens, file: r.file, line: r.line, title: r.title, evidence: r.evidence,
  ...(r.class_of_bug !== null ? { classOfBug: r.class_of_bug } : {}),
  votes: { real: r.votes_real, notReal: r.votes_not_real }, answer: r.answer,
  ...(r.reason !== null ? { reason: r.reason } : {}),
  ...(r.cleared_by !== null ? { clearedBy: r.cleared_by } : {}),
});

export function getReview(db: Db, id: string): Review | undefined {
  const r = db.prepare('SELECT * FROM review WHERE id = ?').get(id) as unknown as ReviewRow | undefined;
  return r && toReview(r);
}
const mustReview = (db: Db, id: string): Review => {
  const r = getReview(db, id);
  if (!r) throw new Error(`review not found: ${id}`);
  return r;
};
const mustFinding = (db: Db, id: string): FindingRow => {
  const r = db.prepare('SELECT * FROM finding WHERE id = ?').get(id) as unknown as FindingRow | undefined;
  if (!r) throw new Error(`finding not found: ${id}`);
  return r;
};

export function createReview(db: Db, r: Omit<Review, 'id'>): Review {
  const id = newId('rv');
  db.prepare('INSERT INTO review (id, run_id, project_id, base_sha, head_sha, effort, risk, round, state, approval_sha, approval_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, r.runId, r.projectId, r.baseSha, r.headSha, r.effort, r.risk, r.round, r.state, r.humanApproval?.sha ?? null, r.humanApproval?.at ?? null);
  return mustReview(db, id);
}

const REVIEW_COLS: Record<string, string> = { runId: 'run_id', projectId: 'project_id', baseSha: 'base_sha', headSha: 'head_sha', effort: 'effort', risk: 'risk', round: 'round', state: 'state' };

export function updateReview(db: Db, id: string, patch: Partial<Omit<Review, 'id' | 'humanApproval'>>): Review {
  const p = patch as Record<string, string | number | undefined>;
  const keys = Object.keys(p).filter((k) => k in REVIEW_COLS && p[k] !== undefined);
  if (keys.length) db.prepare(`UPDATE review SET ${keys.map((k) => `${REVIEW_COLS[k]} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => p[k] as string | number), id);
  return mustReview(db, id);
}

export const listReviewsForRun = (db: Db, runId: string): Review[] =>
  (db.prepare('SELECT * FROM review WHERE run_id = ? ORDER BY rowid').all(runId) as unknown as ReviewRow[]).map(toReview);

export function addFindings(db: Db, reviewId: string, round: number, findings: (VerifiedFinding & { severity: Severity; fingerprint: string })[]): Finding[] {
  mustReview(db, reviewId);
  const ins = db.prepare('INSERT INTO finding (id, fingerprint, review_id, round, severity, lens, file, line, title, evidence, class_of_bug, votes_real, votes_not_real, answer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  return tx(db, () => findings.map((f) => {
    const id = newId('fd');
    ins.run(id, f.fingerprint, reviewId, round, f.severity, f.lens, f.file, f.line, f.title, f.evidence, f.classOfBug ?? null, f.votes.real, f.votes.notReal, 'open');
    return toFinding(mustFinding(db, id));
  }));
}

export function listFindings(db: Db, reviewId: string, filter: { severity?: Severity; answer?: Answer; round?: number } = {}): Finding[] {
  const where = ['review_id = ?']; const args: (string | number)[] = [reviewId];
  if (filter.severity) { where.push('severity = ?'); args.push(filter.severity); }
  if (filter.answer) { where.push('answer = ?'); args.push(filter.answer); }
  if (filter.round !== undefined) { where.push('round = ?'); args.push(filter.round); }
  return (db.prepare(`SELECT * FROM finding WHERE ${where.join(' AND ')} ORDER BY rowid`).all(...args) as unknown as FindingRow[]).map(toFinding);
}

export function answerFinding(db: Db, findingId: string, answer: Exclude<Answer, 'open'>, reason?: string): Finding {
  if ((answer as string) === 'open') throw new Error("'open' is not a valid answer");
  mustFinding(db, findingId);
  const why = reason?.trim();
  if ((answer === 'rejected' || answer === 'intentional') && !why) throw new Error(`answer '${answer}' needs a reason`);
  db.prepare('UPDATE finding SET answer = ?, reason = ? WHERE id = ?').run(answer, why || null, findingId);
  return toFinding(mustFinding(db, findingId));
}

export function markCleared(db: Db, findingId: string, sha: string): Finding {
  mustFinding(db, findingId);
  db.prepare("UPDATE finding SET answer = 'fixed', cleared_by = ? WHERE id = ?").run(sha, findingId);
  return toFinding(mustFinding(db, findingId));
}

export function setHumanApproval(db: Db, reviewId: string, sha: string): Review {
  mustReview(db, reviewId);
  db.prepare('UPDATE review SET approval_sha = ?, approval_at = ? WHERE id = ?').run(sha, new Date().toISOString(), reviewId);
  return mustReview(db, reviewId);
}

export function clearHumanApproval(db: Db, reviewId: string): Review {
  mustReview(db, reviewId);
  db.prepare('UPDATE review SET approval_sha = NULL, approval_at = NULL WHERE id = ?').run(reviewId);
  return mustReview(db, reviewId);
}

/** Every fingerprint ever stored for the project (used later to drop repeated findings). */
export const postedFingerprints = (db: Db, projectId: number): Set<string> =>
  new Set((db.prepare('SELECT DISTINCT f.fingerprint AS fp FROM finding f JOIN review r ON r.id = f.review_id WHERE r.project_id = ?').all(projectId) as unknown as { fp: string }[]).map((x) => x.fp));
