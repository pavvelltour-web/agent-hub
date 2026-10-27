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

/** Reviews of one task branch (project + branch + folder), oldest first. Any run of the branch (task, fixer, resumed) shares them. */
export const listReviewsForBranch = (db: Db, projectId: number, branch: string, cwd: string): Review[] =>
  (db.prepare('SELECT r.* FROM review r JOIN run u ON u.id = r.run_id WHERE r.project_id = ? AND u.branch = ? AND u.cwd = ? ORDER BY r.rowid').all(projectId, branch, cwd) as unknown as ReviewRow[]).map(toReview);

export const INTERRUPTED = 'interrupted by a restart';
/** A round runs in the hub process only: on start, a review left in checks / hunting / verifying is open again with the reason, so it can be restarted. */
export function markInterruptedReviews(db: Db): number {
  const rows = db.prepare("SELECT id, info_json FROM review WHERE state IN ('checks', 'hunting', 'verifying')").all() as unknown as { id: string; info_json: string | null }[];
  for (const r of rows) {
    let info: Record<string, unknown> = {};
    try { const j = r.info_json ? (JSON.parse(r.info_json) as unknown) : {}; if (j && typeof j === 'object' && !Array.isArray(j)) info = j as Record<string, unknown>; } catch { /* unreadable: start clean */ }
    db.prepare("UPDATE review SET state = 'open', info_json = ? WHERE id = ?").run(JSON.stringify({ ...info, reasons: [INTERRUPTED] }), r.id);
  }
  return rows.length;
}

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
  const row = mustFinding(db, findingId);
  if (row.answer !== 'open') throw new Error('only an open finding can be answered');
  const why = reason?.trim();
  if ((answer === 'rejected' || answer === 'intentional') && !why) throw new Error(`answer '${answer}' needs a reason`);
  if (answer === 'dismissed' && (row.severity === 'important' || row.severity === 'security') && !why) throw new Error(`answer 'dismissed' needs a reason for an ${row.severity} finding`);
  db.prepare('UPDATE finding SET answer = ?, reason = ? WHERE id = ?').run(answer, why || null, findingId);
  return toFinding(mustFinding(db, findingId));
}

/** Marks an OPEN finding fixed by commit `sha`. An answer given meanwhile (by the user, between the round's snapshot and now) is never overwritten: `cleared` says whether it changed. */
export function markCleared(db: Db, findingId: string, sha: string): Finding & { cleared: boolean } {
  mustFinding(db, findingId);
  const r = db.prepare("UPDATE finding SET answer = 'fixed', cleared_by = ? WHERE id = ? AND answer = 'open'").run(sha, findingId);
  return { ...toFinding(mustFinding(db, findingId)), cleared: Number(r.changes) === 1 };
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

/** Fingerprints a new round of THIS review must not post again: shown before and not `fixed`. A fixed finding that comes back is new. */
export const repeatFingerprints = (db: Db, reviewId: string): Set<string> =>
  new Set((db.prepare("SELECT DISTINCT fingerprint AS fp FROM finding WHERE review_id = ? AND answer != 'fixed'").all(reviewId) as unknown as { fp: string }[]).map((x) => x.fp));

/** Every fingerprint ever stored for the project: history only. Never used to drop findings (that is `repeatFingerprints`, scoped to one review). */
export const postedFingerprints = (db: Db, projectId: number): Set<string> =>
  new Set((db.prepare('SELECT DISTINCT f.fingerprint AS fp FROM finding f JOIN review r ON r.id = f.review_id WHERE r.project_id = ?').all(projectId) as unknown as { fp: string }[]).map((x) => x.fp));
