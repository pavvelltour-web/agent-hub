import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authStatus } from '../adapters/auth.ts';
import { detectAgents } from '../adapters/locate.ts';
import type { AgentId } from '../core/types.ts';
import { MODEL_ID } from '../econ/router.ts';
import type { Db } from '../history/store.ts';
import { redact } from '../lib/redact.ts';
import { checkpoint, git } from '../run/git.ts';
import type { RunManager, RunRow } from '../run/runner.ts';
import { ReviewError, hunt, verifyMany } from './agents.ts';
import { defaultChecks, dependencyFindings, gateChecks, readReviewConfig, type CheckResult } from './checks.ts';
import { humanPathsFromReviewMd, loadReviewMd } from './reviewmd.ts';
import { riskTier } from './risk.ts';
import { addFindings, answerFinding, clearHumanApproval, createReview, getReview, listFindings, listReviewsForRun, markCleared, postedFingerprints, setHumanApproval, updateReview } from './store.ts';
import { diffLinesFromUnified, triage } from './triage.ts';
import { fingerprint } from './types.ts';
import type { Answer, Effort, Finding, Lens, RawFinding, Review, ReviewerPick, Severity, VerifiedFinding } from './types.ts';

export const RECONSIDER_MESSAGE = 'Три круга ревью не сошлись — пересмотрите подход';
export const ROUND_CAP = 3;
const MAX_NITS = 5;
const MAX_VERIFIED = 30;            // raw findings sent to verifiers per round: a runaway hunter must not decide the spend
const RUN_SLOTS = 3;                // reviewer processes at once (the RunManager allows 4: one stays free for the user)
const HEX40 = /^[0-9a-f]{40}$/;

/** A refusal that the HTTP layer can show as-is. */
export class GateError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = 'GateError'; this.status = status; }
}

// ---- who reviews ---------------------------------------------------------------------------------------------------------------------

export interface Picks { hunters: { lens: Lens; pick: ReviewerPick }[]; verifiers: ReviewerPick[]; security: { lens: 'security'; pick: ReviewerPick }; warnings: string[] }

const HUNT_LENSES: Record<Effort, Lens[]> = { quick: ['correctness'], standard: ['correctness', 'edge-cases', 'intent'], deep: ['correctness', 'edge-cases', 'intent', 'concurrency', 'ui'] };
const VERIFIERS: Record<Effort, number> = { quick: 1, standard: 2, deep: 3 };
const pickOf = (a: AgentId): ReviewerPick => (a === 'claude' ? { agent: 'claude', model: MODEL_ID.opus, effort: 'high' } : { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' });

/** Hunters alternate vendors, verifiers are Claude Opus (Codex only when Claude is missing), plus one separate security pass. `null` when no vendor is usable. */
export function pickReviewers(effort: Effort, available: AgentId[]): Picks | null {
  const vendors = (['claude', 'codex'] as AgentId[]).filter((a) => available.includes(a));
  if (!vendors.length) return null;
  const lenses = HUNT_LENSES[effort] ?? HUNT_LENSES.standard;
  const warnings: string[] = [];
  if (vendors.length === 1) warnings.push(`only ${vendors[0]} is usable: every reviewer runs on one vendor, so there is no cross-vendor diversity`);
  const verifier = pickOf(vendors.includes('claude') ? 'claude' : (vendors[0] as AgentId));
  if (verifier.agent !== 'claude') warnings.push('claude is not usable: verifiers run on codex instead of Claude Opus');
  return {
    hunters: lenses.map((lens, i) => ({ lens, pick: pickOf(vendors[i % vendors.length] as AgentId) })),
    verifiers: Array.from({ length: VERIFIERS[effort] ?? 2 }, () => verifier),
    security: { lens: 'security', pick: pickOf(vendors[lenses.length % vendors.length] as AgentId) },
    warnings,
  };
}

/** Agents that can really review now: installed, signed in, and (codex) not on an account that rejects gpt-6.1-sol (observed for ChatGPT sign-in). */
export function usableAgents(): { available: AgentId[]; warnings: string[] } {
  const info = detectAgents(); const available: AgentId[] = []; const warnings: string[] = [];
  for (const id of ['claude', 'codex'] as AgentId[]) {
    const i = info[id];
    if (!i.installed) { warnings.push(`${id}: not installed`); continue; }
    const a = authStatus(id, i);
    if (a.loggedIn !== true) { warnings.push(`${id}: not signed in`); continue; }
    if (id === 'codex' && /chatgpt/i.test(a.how)) { warnings.push('codex: signed in with a ChatGPT account, which rejects gpt-6.1-sol (observed): not used'); continue; }
    available.push(id);
  }
  return { available, warnings };
}

// ---- small helpers -------------------------------------------------------------------------------------------------------------------

interface Info { completed: number; lastReviewedSha?: string; reasons: string[]; warnings: string[]; checks: CheckResult[]; riskWhy: string[] }

const getInfo = (db: Db, id: string): Info => {
  const row = db.prepare('SELECT info_json FROM review WHERE id = ?').get(id) as { info_json: string | null } | undefined;
  let j: Partial<Info> = {};
  try { j = row?.info_json ? (JSON.parse(row.info_json) as Partial<Info>) : {}; } catch { /* unreadable: start clean */ }
  return { completed: Number(j.completed) || 0, ...(typeof j.lastReviewedSha === 'string' ? { lastReviewedSha: j.lastReviewedSha } : {}), reasons: Array.isArray(j.reasons) ? j.reasons.map(String) : [], warnings: Array.isArray(j.warnings) ? j.warnings.map(String) : [], checks: Array.isArray(j.checks) ? j.checks : [], riskWhy: Array.isArray(j.riskWhy) ? j.riskWhy.map(String) : [] };
};
const putInfo = (db: Db, id: string, info: Info): void => { db.prepare('UPDATE review SET info_json = ? WHERE id = ?').run(JSON.stringify(info), id); };

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const oneLine = (s: string, n: number): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const short = (sha: string): string => sha.slice(0, 10);
const IN_PROGRESS = new Set<Review['state']>(['checks', 'hunting', 'verifying']);
const BLOCKING_SEVERITY = new Set<Severity>(['important', 'security']);
const running = new Set<string>();

function gitText(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Text of `file` in commit `sha`: `null` = not in that commit (deleted, moved), `undefined` = cannot tell. Argument arrays only; model-supplied paths are checked first. */
function fileAt(cwd: string, sha: string, file: string): string | null | undefined {
  if (!HEX40.test(sha) || !file || file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) return undefined;
  const spec = `${sha}:${file.replace(/\\/g, '/')}`;
  const t = gitText(cwd, ['cat-file', '-t', spec]);
  if (!t.ok) return null;
  if (t.out.trim() !== 'blob') return undefined;
  const s = gitText(cwd, ['show', spec]);
  return s.ok ? s.out : undefined;
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length); let next = 0; let failed: { e: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++; if (i >= tasks.length) return;
      try { out[i] = await (tasks[i] as () => Promise<T>)(); } catch (e) { failed = { e }; }   // no new reviewer starts after a failure
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  if (failed) throw failed.e;
  return out;
}

// ---- the state of a review, computed from facts ----------------------------------------------------------------------------------------

const blockers = (db: Db, id: string): Finding[] => listFindings(db, id, { answer: 'open' }).filter((f) => BLOCKING_SEVERITY.has(f.severity));

/** Moves a finished review between open / needs-human / passed after an answer, an approval or a round. A round in progress and `reconsider` are left alone. */
function settle(db: Db, id: string): Review {
  const r = getReview(db, id);
  if (!r) throw new GateError(404, 'review not found');
  if (r.state === 'reconsider' || IN_PROGRESS.has(r.state)) return r;
  const state: Review['state'] = getInfo(db, id).reasons.length || blockers(db, id).length ? 'open'
    : r.risk === 'high' && r.humanApproval?.sha !== r.headSha ? 'needs-human' : 'passed';
  return state === r.state ? r : updateReview(db, id, { state });
}

export function answer(db: Db, findingId: string, a: Exclude<Answer, 'open'>, reason?: string): Finding {
  const f = answerFinding(db, findingId, a, reason);
  settle(db, f.reviewId);
  return f;
}

/** Only a human can approve, and only a commit: the approval is for that sha alone (see canAccept) and any new round drops it. */
export function approve(db: Db, reviewId: string, sha: string, by: 'human'): Review {
  if (by !== 'human') throw new Error('only a human can approve a review');
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('approval needs a commit sha');
  if (!getReview(db, reviewId)) throw new GateError(404, 'review not found');
  setHumanApproval(db, reviewId, sha.toLowerCase());
  return settle(db, reviewId);
}

export function canAccept(db: Db, reviewId: string, headSha: string): { ok: boolean; why: string[] } {
  const r = getReview(db, reviewId);
  if (!r) return { ok: false, why: ['no review yet'] };
  const head = String(headSha).toLowerCase();
  const why: string[] = [];
  if (r.headSha.toLowerCase() !== head) why.push(`no review yet for commit ${short(head)}: the last review covers ${short(r.headSha)}`);
  why.push(...getInfo(db, reviewId).reasons);
  if (IN_PROGRESS.has(r.state)) why.push('the review is still running');
  if (r.state === 'reconsider' && !why.includes(RECONSIDER_MESSAGE)) why.push(RECONSIDER_MESSAGE);
  const open = blockers(db, reviewId);
  const sec = open.filter((f) => f.severity === 'security').length, imp = open.length - sec;
  if (sec) why.push(`${sec} open security finding${sec === 1 ? '' : 's'}`);
  if (imp) why.push(`${imp} open important finding${imp === 1 ? '' : 's'}`);
  if (r.risk === 'high' && r.humanApproval?.sha.toLowerCase() !== head) why.push(`high-risk change: a human must approve commit ${short(head)}`);
  if (!why.length && r.state === 'open') why.push('the review is open');
  return { ok: why.length === 0, why };
}

/** The open Important / Security findings in the exact line format the fixer receives. */
export function blockingLines(db: Db, reviewId: string): string[] {
  return blockers(db, reviewId).map((f) => `BLOCKING: ${oneLine(f.file, 300)}:${f.line} — ${oneLine(f.title, 300)}`);
}

const SEV: Record<Severity, number> = { security: 0, important: 1, nit: 2, 'pre-existing': 3 };

/** The flagged line and up to 3 lines each side, as the commit has them. Built for the screen: redacted, each line capped; `null` when the file or line cannot be read. */
export interface Hunk { from: number; at: number; lines: string[] }
const HUNK_CONTEXT = 3, HUNK_LINE_CAP = 240, HUNK_FILE_CAP = 2_000_000;
function hunkOf(cwd: string, sha: string, file: string, line: number, cache: Map<string, string[] | null>): Hunk | null {
  if (!HEX40.test(sha) || typeof file !== 'string' || !file || file.length > 1024 || file.startsWith('-') || file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..')) return null;
  const path = file.replace(/\\/g, '/');
  if (!cache.has(path)) {
    const r = gitText(cwd, ['show', `${sha}:${path}`]);
    const lines = r.ok && r.out.length <= HUNK_FILE_CAP ? r.out.split(/\r?\n/) : null;
    if (lines && lines.length > 1 && lines[lines.length - 1] === '') lines.pop();   // the file's final newline is not a line
    cache.set(path, lines);
  }
  const all = cache.get(path);
  if (!all || !Number.isInteger(line) || line < 1 || line > all.length) return null;
  const from = Math.max(1, line - HUNK_CONTEXT), to = Math.min(all.length, line + HUNK_CONTEXT);
  return { from, at: line - from, lines: all.slice(from - 1, to).map((l) => redact(l.slice(0, HUNK_LINE_CAP))) };
}

export type FindingView = Finding & { hunk: Hunk | null };
export function reviewView(db: Db, id: string): { review: Review; findings: FindingView[]; checks: CheckResult[]; warnings: string[]; reasons: string[]; riskWhy: string[] } {
  const review = getReview(db, id);
  if (!review) throw new GateError(404, 'review not found');
  const info = getInfo(db, id);
  const cwd = (db.prepare('SELECT cwd FROM run WHERE id = ?').get(review.runId) as { cwd: string | null } | undefined)?.cwd;
  const cache = new Map<string, string[] | null>();
  const findings = listFindings(db, id).sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.round - b.round)
    .map((f) => ({ ...f, hunk: cwd && existsSync(cwd) ? hunkOf(cwd, review.headSha, f.file, f.line, cache) : null }));
  return { review, findings, checks: info.checks, warnings: info.warnings, reasons: info.reasons, riskWhy: info.riskWhy };
}
export const reviewsOfRun = (db: Db, runId: string): Review[] => listReviewsForRun(db, runId);

/**
 * Interim fixer entry point (the cascade does not exist yet): resumes the task thread on its own branch with the open Important/Security
 * `blockingLines`, verbatim, as the whole prompt. The runner applies the thread's own permission; a review-mode thread is never the target.
 */
export function startFix(db: Db, runs: RunManager, reviewId: string): RunRow {
  const r = getReview(db, reviewId);
  if (!r) throw new GateError(404, 'review not found');
  if (IN_PROGRESS.has(r.state)) throw new GateError(409, 'the review is still running');
  const lines = blockingLines(db, reviewId);
  if (!lines.length) throw new GateError(400, 'nothing to fix: no open important or security findings');
  const base = runs.get(r.runId);
  if (!base?.cwd || !base.branch?.startsWith('hub/')) throw new GateError(400, 'only task runs on a hub/… branch can be fixed');
  if (base.workMode === 'review') throw new GateError(400, 'a review thread is read-only and cannot be fixed');
  if (db.prepare('SELECT 1 FROM run WHERE cwd = ? AND outcome IS NULL LIMIT 1').get(base.cwd)) throw new GateError(409, 'the agent is still working in this branch');
  const prev = db.prepare("SELECT id FROM run WHERE cwd = ? AND branch = ? AND session_native_id IS NOT NULL AND (work_mode IS NULL OR work_mode != 'review') ORDER BY started_at DESC, rowid DESC LIMIT 1").get(base.cwd, base.branch) as { id: string } | undefined;
  const target = prev ? runs.get(prev.id) : undefined;
  if (!target) throw new GateError(409, 'nothing to resume: the task run has no session id');
  if (target.permission === 'plan') throw new GateError(409, 'the task thread is read-only: allow edits in the chat first');
  const root = (db.prepare('SELECT root FROM project WHERE id = ?').get(r.projectId) as { root: string } | undefined)?.root;
  if (!root) throw new GateError(404, 'project not found');
  try {
    return runs.start({ agent: target.agent as AgentId, prompt: lines.join('\n'), projectRoot: root, resumeRunId: target.id, ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}), ...(target.cls ? { cls: target.cls } : {}) });
  } catch (e) { throw new GateError(400, e instanceof Error ? e.message : 'could not start the fixer'); }
}

// ---- starting a round ------------------------------------------------------------------------------------------------------------------

export interface GateOpts {
  runId: string; effort?: Effort; runs: RunManager; db: Db;
  /** Agents that may review. Default: the signed-in ones (`usableAgents`). */
  available?: AgentId[];
  /** Replaces `pickReviewers` (tests). */
  picks?: Picks;
  timeoutMs?: number;
}
interface RunInfo { id: string; project_id: number | null; cwd: string | null; branch: string | null; base_sha: string | null; prompt: string | null; outcome: string | null }

function begin(o: GateOpts): { review: Review; fresh: boolean } {
  const run = o.db.prepare('SELECT id, project_id, cwd, branch, base_sha, prompt, outcome FROM run WHERE id = ?').get(o.runId) as RunInfo | undefined;
  if (!run) throw new GateError(404, 'run not found');
  if (run.outcome === null) throw new GateError(409, 'the run is still running');
  if (!run.branch?.startsWith('hub/') || !run.cwd || !existsSync(run.cwd) || run.project_id == null) throw new GateError(400, 'only task runs on a hub/… branch can be reviewed');
  const root = (o.db.prepare('SELECT root FROM project WHERE id = ?').get(run.project_id) as { root: string } | undefined)?.root;
  if (!root) throw new GateError(404, 'project not found');
  const prior = listReviewsForRun(o.db, o.runId).at(-1);
  if (prior && running.has(prior.id)) return { review: prior, fresh: false };

  // Work the agent left uncommitted becomes a checkpoint commit on its own branch: a review is of a commit, never of a moving tree.
  const cp = checkpoint(run.cwd, 'checkpoint before review');
  if (cp.note) throw new GateError(409, cp.note);
  const head = git(run.cwd, ['rev-parse', 'HEAD']).out;
  const base = run.base_sha ?? ['main', 'master'].map((b) => git(run.cwd as string, ['merge-base', 'HEAD', b]).out).find((s) => HEX40.test(s)) ?? '';
  if (!HEX40.test(head) || !HEX40.test(base)) throw new GateError(409, 'cannot find the commits to review');
  const effort = o.effort ?? ((['quick', 'standard', 'deep'] as const).find((e) => e === readReviewConfig(root).effort) ?? 'standard');

  if (!prior) {
    const review = createReview(o.db, { runId: o.runId, projectId: run.project_id, baseSha: base, headSha: head, effort, risk: 'low', round: 1, state: 'checks' });
    putInfo(o.db, review.id, { completed: 0, reasons: [], warnings: [], checks: [], riskWhy: [] });
    running.add(review.id);
    return { review, fresh: true };
  }
  const info = getInfo(o.db, prior.id);
  if (info.completed >= ROUND_CAP) {              // round 4 is refused: the approach is wrong, not the last patch
    clearHumanApproval(o.db, prior.id);
    putInfo(o.db, prior.id, { ...info, reasons: [RECONSIDER_MESSAGE] });
    return { review: updateReview(o.db, prior.id, { headSha: head, state: 'reconsider' }), fresh: false };
  }
  if (!info.reasons.length && !IN_PROGRESS.has(prior.state) && info.lastReviewedSha === head) return { review: settle(o.db, prior.id), fresh: false };   // nothing new to review
  clearHumanApproval(o.db, prior.id);
  const review = updateReview(o.db, prior.id, { headSha: head, effort, round: info.completed + 1, state: 'checks' });
  putInfo(o.db, prior.id, { ...info, reasons: [], warnings: [], checks: [] });
  running.add(review.id);
  return { review, fresh: true };
}

/** Creates (or advances) the review and returns it at once; `done` resolves when the round has finished. Never rejects. */
export function launchReview(o: GateOpts): { review: Review; done: Promise<Review> } {
  const { review, fresh } = begin(o);
  return { review, done: fresh ? runRound(o, review) : Promise.resolve(review) };
}

export async function startReview(o: GateOpts): Promise<Review> {
  return launchReview(o).done;
}

async function runRound(o: GateOpts, review: Review): Promise<Review> {
  const { db } = o;
  const info = getInfo(db, review.id);
  const close = (reason: string): void => { putInfo(db, review.id, { ...info, reasons: [oneLine(reason, 400)] }); updateReview(db, review.id, { state: 'open' }); };
  try {
    const run = db.prepare('SELECT cwd, prompt FROM run WHERE id = ?').get(review.runId) as { cwd: string; prompt: string | null };
    const root = (db.prepare('SELECT root FROM project WHERE id = ?').get(review.projectId) as { root: string }).root;
    const cwd = run.cwd, head = review.headSha, round = review.round;
    const from = info.lastReviewedSha ?? review.baseSha;
    const cache = new Map<string, string[] | null>();
    const linesOf = (file: string): string[] | null => {
      if (!cache.has(file)) { const t = fileAt(cwd, head, file); cache.set(file, typeof t === 'string' ? t.split(/\r?\n/) : null); }
      return cache.get(file) ?? null;
    };
    const lineText = (file: string, line: number): string => linesOf(file)?.[line - 1] ?? '';

    // A later commit that no longer contains a flagged line answers that finding.
    for (const f of listFindings(db, review.id, { answer: 'open' })) {
      const stored = (db.prepare('SELECT line_text FROM finding WHERE id = ?').get(f.id) as { line_text: string | null }).line_text;
      if (!stored || stored.length < 3) continue;
      const text = fileAt(cwd, head, f.file);
      if (text === undefined) continue;
      if (text === null || !text.split(/\r?\n/).some((l) => squash(l) === stored)) markCleared(db, f.id, head);
    }

    const diffArgs = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', `${from}..${head}`];
    const diff = gitText(cwd, diffArgs.slice(1));
    if (!diff.ok) return finish(close('cannot read the diff'));
    if (!diff.out.trim()) return finish(close(`nothing to review: no changes since ${short(from)}`));

    // Every path the branch changed (not only this round): scopes the folder REVIEW.md files and decides the risk tier.
    const names = gitText(cwd, ['diff', '--name-only', '--no-renames', '-z', `${review.baseSha}..${head}`]);
    const changed = names.ok ? names.out.split('\0').filter(Boolean) : [];

    // 0 Checks: red means no AI is started.
    const gate = await gateChecks(cwd, defaultChecks(root), { diffText: diff.out });
    putInfo(db, review.id, { ...info, checks: gate.results }); info.checks = gate.results;
    if (!gate.ok) return finish(close(`checks failed: ${gate.results.find((r) => !r.ok)?.name ?? 'unknown'}`));

    const usable = o.available ? { available: o.available, warnings: [] as string[] } : usableAgents();
    const picks = o.picks ?? pickReviewers(review.effort, usable.available);
    if (!picks) return finish(close(`no usable reviewer: sign in to claude or codex (${usable.warnings.join('; ') || 'none available'})`));
    info.warnings = [...picks.warnings, ...usable.warnings];
    putInfo(db, review.id, info);

    // 1 Hunt
    updateReview(db, review.id, { state: 'hunting' });
    const read = (name: string): string => { try { return readFileSync(join(root, name), 'utf8'); } catch { return ''; } };
    const common = { diffCmd: ['git', ...diffArgs], brief: run.prompt ?? '', agentsMd: read('AGENTS.md'), reviewMd: loadReviewMd(root, changed), runs: o.runs, cwd, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) };
    const found = (await pool([...picks.hunters, picks.security].map((h) => () => hunt({ ...common, lens: h.lens, pick: h.pick })), RUN_SLOTS)).flat();

    // 2 Verify: only bugs and risks, each once, never what an earlier round already posted.
    const posted = postedFingerprints(db, review.projectId);
    const seen = new Set<string>(); const todo: RawFinding[] = [];
    for (const f of found) {
      if (f.category !== 'bug' && f.category !== 'risk') continue;
      const file = f.file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      const key = `${file}\0${f.line}\0${f.title}`;
      if (seen.has(key)) continue; seen.add(key);
      if (posted.has(fingerprint({ file, title: f.title.slice(0, 300), ...(f.classOfBug ? { classOfBug: f.classOfBug.slice(0, 200) } : {}) }, lineText(file, f.line).slice(0, 2000)))) continue;
      todo.push(f);
    }
    updateReview(db, review.id, { state: 'verifying' });
    const k = Math.max(1, picks.verifiers.length);
    const verified = (await pool(todo.slice(0, MAX_VERIFIED).map((f) => () => verifyMany(f, { picks: picks.verifiers, diffCmd: common.diffCmd, runs: o.runs, cwd, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) })), Math.max(1, Math.floor(RUN_SLOTS / k)))).filter((v): v is VerifiedFinding => v !== null);
    for (const d of dependencyFindings(diff.out, cwd)) verified.push({ ...d, votes: { real: 1, notReal: 0 } });

    // 3 Filter and 4 Security tagging (triage), then store.
    const kept = triage(verified, { diffLines: diffLinesFromUnified(diff.out), maxNits: MAX_NITS, posted, reviewId: review.id, round, lineText });
    const stored = addFindings(db, review.id, round, kept.map((f) => ({ ...f, category: 'bug' as const })));
    stored.forEach((s, i) => { const f = kept[i] as Finding; db.prepare('UPDATE finding SET line_text = ? WHERE id = ?').run(squash(lineText(f.file, f.line)).slice(0, 2000) || null, s.id); });

    // 5 Risk from every path the branch changed (not only this round), config from the project root.
    const humanPaths = [...(readReviewConfig(root).humanPaths ?? []), ...humanPathsFromReviewMd(loadReviewMd(root, []))];   // hub.json + the project's REVIEW.md, both from the project root
    const tier = names.ok ? riskTier(changed, { humanPaths }) : { tier: 'high' as const, why: ['changed paths unreadable'] };
    updateReview(db, review.id, { risk: tier.tier });

    putInfo(db, review.id, { ...info, completed: info.completed + 1, lastReviewedSha: head, reasons: [], riskWhy: tier.why.map((w) => oneLine(w, 300)).slice(0, 20) });
    updateReview(db, review.id, { state: 'open' });     // 6-7: settle() decides between open / needs-human / passed
    return finish(undefined);
  } catch (e) {
    close(e instanceof ReviewError ? `reviewer failed: ${e.message}` : `review stopped: ${e instanceof Error ? e.message : 'unknown error'}`);
    return finish(undefined);
  }

  function finish(_: void): Review {
    running.delete(review.id);
    return settle(db, review.id);
  }
}
