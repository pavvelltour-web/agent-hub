// Reviewer quality: known-buggy and known-clean diffs run through the gate's hunt / verify / triage pipeline, scored for recall and noise.
// Seed cases ship in eval/review/<id>/{case.json,case.diff} (read-only). Incidents (a finding that was rejected and came back, a failed task, a
// reverted commit) become cases through saveCase under <hub home>/review-eval/cases. Nothing here needs a git repository: the pipeline works on the diff text.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../core/registry.ts';
import type { AgentId } from '../core/types.ts';
import type { Db } from '../history/store.ts';
import { redact } from '../lib/redact.ts';
import type { RunManager } from '../run/runner.ts';
import { hunt, verifyMany } from './agents.ts';
import { MAX_NITS, MAX_VERIFIED, RUN_SLOTS, pickReviewers, pool, usableAgents, type Picks } from './gate.ts';
import { diffLinesFromUnified, triage, unifiedLines } from './triage.ts';
import { fingerprint } from './types.ts';
import type { Answer, Effort, Finding, RawFinding, VerifiedFinding } from './types.ts';

export interface ReviewCase {
  id: string; title: string; kind: 'buggy' | 'clean';
  /** Unified diff text; stored as eval/review/<id>/case.diff. */
  diff: string;
  /** Known bugs (file and line in the NEW file); empty for a clean case. */
  bugs: { file: string; line: number }[];
  source?: 'seed' | 'incident';
  brief?: string;
}

export const MAX_DIFF_BYTES = 200 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_BRIEF = 20_000;
const MAX_BUGS = 50;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MATCH_WINDOW = 3;
const ANSWERS: Answer[] = ['open', 'fixed', 'rejected', 'intentional', 'dismissed'];
const BLOCKING = new Set(['important', 'security']);

const normFile = (f: string): string => f.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ---- shape checks -----------------------------------------------------------------------------------------------------------------------

function safeFile(f: unknown): string | null {
  if (typeof f !== 'string' || !f || f.length > 1024 || /[\u0000-\u001f]/.test(f) || /^[\\/]/.test(f) || /^[A-Za-z]:/.test(f)) return null;
  const n = normFile(f);
  return n && !n.split('/').includes('..') ? n : null;
}

/** The case without its diff, or the reason it is unusable. `id` must be the folder name when given. */
function checkMeta(raw: unknown, folder?: string): { ok: true; value: Omit<ReviewCase, 'diff'> } | { ok: false; why: string } {
  if (!isObj(raw)) return { ok: false, why: 'case.json is not an object' };
  const id = raw['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, why: 'bad id' };
  if (folder !== undefined && id !== folder) return { ok: false, why: 'id does not match the folder name' };
  const title = raw['title'];
  if (typeof title !== 'string' || !title.trim() || title.length > 200) return { ok: false, why: 'bad title' };
  const kind = raw['kind'];
  if (kind !== 'buggy' && kind !== 'clean') return { ok: false, why: 'kind must be buggy or clean' };
  if (!Array.isArray(raw['bugs']) || raw['bugs'].length > MAX_BUGS) return { ok: false, why: 'bugs must be a short list' };
  const bugs: ReviewCase['bugs'] = [];
  for (const b of raw['bugs']) {
    const file = isObj(b) ? safeFile(b['file']) : null;
    const line = isObj(b) ? b['line'] : undefined;
    if (!file || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) return { ok: false, why: 'a bug needs a safe file and a line >= 1' };
    bugs.push({ file, line });
  }
  if (kind === 'buggy' && !bugs.length) return { ok: false, why: 'a buggy case needs at least one known bug' };
  if (kind === 'clean' && bugs.length) return { ok: false, why: 'a clean case has no known bugs' };
  const source = raw['source'];
  if (source !== undefined && source !== 'seed' && source !== 'incident') return { ok: false, why: 'bad source' };
  const brief = raw['brief'];
  if (brief !== undefined && (typeof brief !== 'string' || brief.length > MAX_BRIEF)) return { ok: false, why: 'bad brief' };
  return { ok: true, value: { id, title: title.trim(), kind, bugs, ...(source ? { source } : {}), ...(typeof brief === 'string' ? { brief } : {}) } };
}

const plainFileSize = (p: string): number | null => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink() ? s.size : null; } catch { return null; } };

/** The shipped seed cases (read-only, part of the package). */
export const SEED_CASES_DIR = join(REPO_ROOT, 'eval', 'review');
/** Where incident cases are written: under the hub home, never into the hub's own tree. */
export const incidentCasesDir = (home: string): string => join(home, 'review-eval', 'cases');

/**
 * Valid cases of a folder (or of several: seeds first, then incidents; an id seen in an earlier folder wins), sorted by id within a folder.
 * A bad case is skipped (and described in `skipped`): junk must never stop the others.
 */
export function loadCases(dir: string | string[], skipped: string[] = []): ReviewCase[] {
  if (Array.isArray(dir)) {
    const out: ReviewCase[] = []; const ids = new Set<string>();
    for (const d of dir) for (const c of loadCases(d, skipped)) { if (ids.has(c.id)) { skipped.push(`${c.id}: duplicate id (kept the first)`); continue; } ids.add(c.id); out.push(c); }
    return out;
  }
  let names: string[];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  const out: ReviewCase[] = [];
  for (const name of names) {
    const skip = (why: string): void => void skipped.push(`${name}: ${why}`);
    if (!ID_RE.test(name)) { skip('folder name is not [a-z0-9-]'); continue; }
    const jsonPath = join(dir, name, 'case.json'), diffPath = join(dir, name, 'case.diff');
    const jsonSize = plainFileSize(jsonPath), diffSize = plainFileSize(diffPath);
    if (jsonSize === null || diffSize === null) { skip('case.json or case.diff is missing or not a plain file'); continue; }
    if (jsonSize > MAX_JSON_BYTES) { skip('case.json is too large'); continue; }
    if (diffSize > MAX_DIFF_BYTES) { skip('case.diff is larger than 200 KB'); continue; }
    let meta: ReturnType<typeof checkMeta>;
    try { meta = checkMeta(JSON.parse(readFileSync(jsonPath, 'utf8')), name); } catch { skip('case.json is not valid JSON'); continue; }
    if (!meta.ok) { skip(meta.why); continue; }
    const diff = readFileSync(diffPath, 'utf8');
    if (!diff.trim()) { skip('case.diff is empty'); continue; }
    out.push({ ...meta.value, diff });
  }
  return out;
}

export interface CaseSummary { total: number; seed: number; incident: number; buggy: number; clean: number }
export function caseSummary(dir: string | string[]): CaseSummary {
  const cases = loadCases(dir);
  return { total: cases.length, seed: cases.filter((c) => c.source === 'seed').length, incident: cases.filter((c) => c.source === 'incident').length, buggy: cases.filter((c) => c.kind === 'buggy').length, clean: cases.filter((c) => c.kind === 'clean').length };
}

// ---- scoring ---------------------------------------------------------------------------------------------------------------------------

/**
 * How many of the known bugs were found. A finding finds a bug when it is Important or Security (never a nit, never pre-existing),
 * names the same file and sits within 3 lines of the bug's line.
 */
export function matchedBugs(bugs: ReviewCase['bugs'], findings: Finding[]): number {
  const real = findings.filter((f) => BLOCKING.has(f.severity));
  return bugs.filter((b) => real.some((f) => normFile(f.file) === normFile(b.file) && Math.abs(f.line - b.line) <= MATCH_WINDOW)).length;
}

/**
 * recall = found known bugs / known bugs (all cases together; 1 when there are no known bugs: nothing was missed).
 * noiseOnClean = mean Important/Security findings per clean case (0 when there is no clean case).
 */
export function scoreFindings(cases: ReviewCase[], found: Record<string, Finding[]>): { recall: number; noiseOnClean: number } {
  let bugs = 0, hit = 0, noise = 0, clean = 0;
  for (const c of cases) {
    const fs = found[c.id] ?? [];
    if (c.kind === 'buggy') { bugs += c.bugs.length; hit += matchedBugs(c.bugs, fs); }
    else { clean++; noise += fs.filter((f) => BLOCKING.has(f.severity)).length; }
  }
  return { recall: bugs ? hit / bugs : 1, noiseOnClean: clean ? noise / clean : 0 };
}

export interface Scores { recall: number; noiseOnClean: number; roundsToPass: number }

/** A prompt or model change must not lower recall. `tolerance` is an absolute drop that is still accepted. Noise and rounds are reported, not gated. */
export function compareEval(base: Partial<Scores> & Pick<Scores, 'recall'>, next: Partial<Scores> & Pick<Scores, 'recall'>, tolerance = 0): { ok: true } | { ok: false; why: string } {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  if (!Number.isFinite(next.recall) || !Number.isFinite(base.recall)) return { ok: false, why: 'recall could not be read: cannot compare' };
  if (next.recall < base.recall - Math.max(0, tolerance) - 1e-9) return { ok: false, why: `recall fell from ${pct(base.recall)} to ${pct(next.recall)}${tolerance > 0 ? ` (allowed drop ${pct(tolerance)})` : ''}` };
  return { ok: true };
}

export interface Baseline extends Scores { effort: Effort; cases: number; savedAt: string }

const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export function readBaseline(path: string): Baseline | null {
  let j: unknown;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!isObj(j) || !unit(j['recall']) || typeof j['noiseOnClean'] !== 'number' || !Number.isFinite(j['noiseOnClean']) || j['noiseOnClean'] < 0 || typeof j['roundsToPass'] !== 'number' || !Number.isFinite(j['roundsToPass']) || j['roundsToPass'] < 0) return null;
  const effort = j['effort'];
  if (effort !== 'quick' && effort !== 'standard' && effort !== 'deep') return null;
  if (typeof j['cases'] !== 'number' || !Number.isSafeInteger(j['cases']) || j['cases'] < 0 || typeof j['savedAt'] !== 'string' || j['savedAt'].length > 40) return null;
  return { recall: j['recall'], noiseOnClean: j['noiseOnClean'], roundsToPass: j['roundsToPass'], effort, cases: j['cases'], savedAt: j['savedAt'] };
}
export function writeBaseline(path: string, b: Baseline): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(b, null, 2) + '\n');
}

/** Answers given to the findings of real reviews (the `finding` table); zeros without a db. */
export function answerCounts(db?: Db): Record<Answer, number> {
  const out = Object.fromEntries(ANSWERS.map((a) => [a, 0])) as Record<Answer, number>;
  if (!db) return out;
  for (const r of db.prepare('SELECT answer, COUNT(*) AS n FROM finding GROUP BY answer').all() as unknown as { answer: Answer; n: number }[]) if (r.answer in out) out[r.answer] = Number(r.n);
  return out;
}

// ---- running the reviewers on a case ---------------------------------------------------------------------------------------------

export interface EvalOpts {
  cases: ReviewCase[]; effort: Effort; runs: RunManager;
  /** Replaces `pickReviewers` (tests). */
  picks?: Picks;
  /** Agents that may review; default: the signed-in ones. */
  available?: AgentId[];
  /** For `byAnswer`. */
  db?: Db;
  /** Folder the reviewers start in; default: an empty temporary folder (removed afterwards). */
  cwd?: string;
  timeoutMs?: number;
  /** Cap of reviewer rounds per case (default 3, like the gate). */
  maxRounds?: number;
}
export interface CaseResult { id: string; kind: ReviewCase['kind']; bugs: number; found: number; blocking: number; rounds: number }
export interface EvalResult extends Scores { byAnswer: Record<Answer, number>; cases: CaseResult[] }

/** One reviewer round on a diff text: hunt (every lens + the security pass), verify what survives, triage. No repository, no checks, no dependency scan. */
async function reviewOnce(c: ReviewCase, o: { picks: Picks; runs: RunManager; cwd: string; timeoutMs?: number; posted: Set<string>; round: number }): Promise<Finding[]> {
  const texts = new Map<string, string>();
  for (const l of unifiedLines(c.diff)) if (l.file && l.op !== '-') texts.set(`${l.file}:${l.line}`, l.text);
  const lineText = (file: string, line: number): string => texts.get(`${file}:${line}`) ?? '';
  const common = { runs: o.runs, cwd: o.cwd, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) };
  const found = (await pool([...o.picks.hunters, o.picks.security].map((h) => () => hunt({ ...common, lens: h.lens, pick: h.pick, diffText: c.diff, brief: c.brief ?? '', agentsMd: '' })), RUN_SLOTS)).flat();
  const seen = new Set<string>(); const todo: RawFinding[] = [];
  for (const f of found) {
    if (f.category !== 'bug' && f.category !== 'risk') continue;
    const file = normFile(f.file);
    const key = `${file}\0${f.line}\0${f.title}`;
    if (seen.has(key)) continue; seen.add(key);
    if (o.posted.has(fingerprint({ file, title: f.title.slice(0, 300), ...(f.classOfBug ? { classOfBug: f.classOfBug.slice(0, 200) } : {}) }, lineText(file, f.line).slice(0, 2000)))) continue;
    todo.push(f);
  }
  const k = Math.max(1, o.picks.verifiers.length);
  const verified = (await pool(todo.slice(0, MAX_VERIFIED).map((f) => () => verifyMany(f, { ...common, picks: o.picks.verifiers, diffText: c.diff })), Math.max(1, Math.floor(RUN_SLOTS / k)))).filter((v): v is VerifiedFinding => v !== null);
  return triage(verified, { diffLines: diffLinesFromUnified(c.diff), maxNits: MAX_NITS, posted: o.posted, reviewId: 'eval', round: o.round, lineText });
}

/**
 * Runs the reviewers on every case and scores them. Recall and noise come from the FIRST round on each case.
 *
 * roundsToPass: without a live author the harness cannot fix the code, so the honest number is how many rounds the reviewer needed before
 * it stopped reporting NEW Important/Security findings on the unchanged diff: round 1 reports nothing blocking = 1; otherwise the findings
 * count as posted (the gate never shows a repeat) and the reviewers go again, until a round adds nothing blocking or `maxRounds` is reached.
 * A buggy case therefore costs at least 2 rounds of reviewer spend. The mean over all cases is returned.
 *
 * A reviewer that fails (no structured result, timeout) aborts the evaluation: it must never count as "found nothing".
 */
export async function evalReviewer(o: EvalOpts): Promise<EvalResult> {
  const picks = o.picks ?? pickReviewers(o.effort, o.available ?? usableAgents().available);
  if (!picks) throw new Error('no usable reviewer: sign in first (claude or codex), then repeat');
  const maxRounds = Math.max(1, Math.floor(o.maxRounds ?? 3));
  const own = o.cwd === undefined ? mkdtempSync(join(tmpdir(), 'hub-evalcwd-')) : undefined;
  const cwd = o.cwd ?? (own as string);
  try {
    const first: Record<string, Finding[]> = {}; const results: CaseResult[] = [];
    for (const c of o.cases) {
      const posted = new Set<string>();
      let rounds = 0;
      while (rounds < maxRounds) {
        rounds++;
        const fs = await reviewOnce(c, { picks, runs: o.runs, cwd, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), posted, round: rounds });
        if (rounds === 1) first[c.id] = fs;
        const fresh = fs.filter((f) => BLOCKING.has(f.severity));
        for (const f of fs) posted.add(f.fingerprint);
        if (!fresh.length) break;
      }
      const fs = first[c.id] ?? [];
      results.push({ id: c.id, kind: c.kind, bugs: c.bugs.length, found: c.kind === 'buggy' ? matchedBugs(c.bugs, fs) : 0, blocking: fs.filter((f) => BLOCKING.has(f.severity)).length, rounds });
    }
    const s = scoreFindings(o.cases, first);
    return { ...s, roundsToPass: results.length ? results.reduce((a, r) => a + r.rounds, 0) / results.length : 0, byAnswer: answerCounts(o.db), cases: results };
  } finally {
    if (own) rmSync(own, { recursive: true, force: true });
  }
}

// ---- incidents become cases ---------------------------------------------------------------------------------------------------------

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Only the section of a multi-file unified diff that changes `file`; `null` when the diff does not touch it. */
export function diffForFile(diff: string, file: string): string | null {
  const want = normFile(file);
  for (const part of String(diff).split(/^(?=diff --git )/m)) {
    if (part.split(/\r?\n/).some((l) => l.startsWith('+++ ') && normFile(l.slice(4).replace(/^b\//, '').split('\t')[0] ?? '') === want)) return part.endsWith('\n') ? part : part + '\n';
  }
  return null;
}

/**
 * A case from an incident: a finding that was rejected and then came back, a failed task or a reverted commit. The caller supplies the diff
 * text and the bug's file and line; only the file's own part of the diff is kept. The id is made from the title and a short hash.
 */
export function caseFromFinding(o: { title: string; diff: string; file: string; line: number; brief?: string }): ReviewCase {
  const file = normFile(o.file);
  const diff = diffForFile(o.diff, file) ?? o.diff;
  const id = `${slug(o.title).slice(0, 48).replace(/-+$/g, '') || 'case'}-${sha(`${file}\0${o.line}\0${diff}`).slice(0, 6)}`;
  return { id, title: o.title.trim().slice(0, 200), kind: 'buggy', diff, bugs: [{ file, line: o.line }], source: 'incident', ...(o.brief ? { brief: o.brief } : {}) };
}

/**
 * Writes <dir>/<id>/{case.json,case.diff} (the server passes <hub home>/review-eval/cases). The id is reduced to [a-z0-9-]; an existing case is never overwritten; the diff and the brief
 * are redacted first; the diff is capped at 200 KB; a known bug must sit within 3 lines of a line the diff adds (else it could never be found).
 */
export function saveCase(dir: string, c: ReviewCase): ReviewCase {
  const id = slug(String(c.id ?? '')).slice(0, 63).replace(/-+$/g, '');
  const meta = checkMeta({ id, title: c.title, kind: c.kind, bugs: c.bugs, ...(c.source ? { source: c.source } : {}), ...(c.brief !== undefined ? { brief: c.brief === '' ? undefined : redact(c.brief) } : {}) });
  if (!meta.ok) throw new Error(`case refused: ${meta.why}`);
  const diff = redact(String(c.diff ?? ''));
  if (!diff.trim()) throw new Error('case refused: the diff is empty');
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new Error('case refused: the diff is larger than 200 KB');
  const added = [...diffLinesFromUnified(diff)].map((k) => { const i = k.lastIndexOf(':'); return { file: k.slice(0, i), line: Number(k.slice(i + 1)) }; });
  for (const b of meta.value.bugs) if (!added.some((a) => a.file === b.file && Math.abs(a.line - b.line) <= MATCH_WINDOW)) throw new Error(`case refused: the bug ${b.file}:${b.line} is not in the diff (no added line within ${MATCH_WINDOW} lines)`);
  mkdirSync(dir, { recursive: true });
  const folder = join(dir, meta.value.id);
  try { mkdirSync(folder); } catch (e) { throw (e as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(`case ${meta.value.id} already exists`) : e; }
  try {
    writeFileSync(join(folder, 'case.diff'), diff.endsWith('\n') ? diff : diff + '\n', { flag: 'wx' });
    writeFileSync(join(folder, 'case.json'), JSON.stringify(meta.value, null, 2) + '\n', { flag: 'wx' });
  } catch (e) { rmSync(folder, { recursive: true, force: true }); throw e; }
  return { ...meta.value, diff };
}
