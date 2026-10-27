import type { Db } from '../history/store.ts';
import type { Effort } from './types.ts';

/**
 * Review guardrails (Phase 7.5): what the last 14 days say about how much the review gate should be trusted. Pure arithmetic on counts; shown to the user, never applied silently.
 * - Accepted work that came back (a branch the gate passed and a later round re-opened) in more than 10 % of the accepted branches: review at Deep effort and a human approval from the
 *   medium risk tier (instead of only the high tier).
 * - Findings the user rejected as wrong in more than 40 % of the answered ones: the reviewer is noisy; the effort stays and the reviewer is flagged for `hub review-eval`.
 * Under MIN_ACCEPTED accepted branches / MIN_FINDINGS answered findings the rule does not fire (a few cases are not a rate) and the answer says so. The thresholds are the plan's, the minimums are this module's.
 */
export interface ReviewWindow { accepted: number; reopened: number; rejectedFindings: number; findings: number }
export interface Guardrails { reviewEffort: Effort; humanFromTier: 'medium' | 'high'; why: string | null; flagReviewer: boolean; tightened: boolean; note: string | null }

export const WINDOW_DAYS = 14;
export const REOPEN_ABOVE = 0.1, NOISE_ABOVE = 0.4;
export const MIN_ACCEPTED = 5, MIN_FINDINGS = 10;
const cnt = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

export function guardrails(w: ReviewWindow): Guardrails {
  const accepted = cnt(w?.accepted), reopened = Math.min(cnt(w?.reopened), accepted), findings = cnt(w?.findings), rejected = Math.min(cnt(w?.rejectedFindings), findings);
  const out: Guardrails = { reviewEffort: 'standard', humanFromTier: 'high', why: null, flagReviewer: false, tightened: false, note: null };
  const why: string[] = [], notes: string[] = [];
  if (accepted >= MIN_ACCEPTED) {
    if (reopened / accepted > REOPEN_ABOVE) { out.reviewEffort = 'deep'; out.humanFromTier = 'medium'; out.tightened = true; why.push(`за ${WINDOW_DAYS} дней вернулись в работу ${reopened} из ${accepted} принятых задач: ревью строже (глубокое) и ваше «да» нужно уже от среднего риска`); }
  } else if (accepted > 0 || reopened > 0) notes.push(`принятых задач за ${WINDOW_DAYS} дней только ${accepted} (нужно ${MIN_ACCEPTED}): вывод о возвратах пока не делается`);
  if (findings >= MIN_FINDINGS) {
    if (rejected / findings > NOISE_ABOVE) { out.flagReviewer = true; why.push(`вы отвергли как ошибочные ${rejected} из ${findings} замечаний: ревьюер шумит, проверьте его командой hub review-eval`); }
  } else if (findings > 0) notes.push(`замечаний с ответом только ${findings} (нужно ${MIN_FINDINGS}): шум ревьюера пока не оценивается`);
  const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
  out.why = why.length ? why.map(cap).join('. ') : null;
  out.note = notes.length ? notes.map(cap).join('. ') : null;
  return out;
}

/**
 * The counts from the hub's own tables, last 14 days. A branch (folder + branch name of a task run) is ACCEPTED when one of its reviews is `passed`; it is REOPENED when a later round of the
 * same branch is not `passed` again. Findings counted are the answered ones of reviews of runs in the window; `rejected` is the answer «ошибочное замечание».
 */
export function reviewWindow(db: Db, now: number = Date.now()): ReviewWindow {
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT v.state AS state, u.cwd AS cwd, u.branch AS branch FROM review v JOIN run u ON u.id = v.run_id WHERE u.branch IS NOT NULL AND u.started_at >= ? ORDER BY v.rowid`).all(since) as unknown as { state: string; cwd: string | null; branch: string }[];
  const byBranch = new Map<string, string[]>();
  for (const r of rows) { const k = `${r.cwd ?? ''}\0${r.branch}`; byBranch.set(k, [...(byBranch.get(k) ?? []), r.state]); }
  let accepted = 0, reopened = 0;
  for (const states of byBranch.values()) {
    const first = states.indexOf('passed');
    if (first < 0) continue;
    accepted++;
    if (states.slice(first + 1).some((s) => s !== 'passed')) reopened++;
  }
  const f = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(f.answer = 'rejected'), 0) AS rej FROM finding f JOIN review v ON v.id = f.review_id JOIN run u ON u.id = v.run_id WHERE f.answer != 'open' AND u.started_at >= ?`).get(since) as unknown as { n: number; rej: number };
  return { accepted, reopened, findings: f.n, rejectedFindings: f.rej };
}
