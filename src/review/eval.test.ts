import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, projectId } from '../history/store.ts';
import { RunManager } from '../run/runner.ts';
import { handle, type Ctx } from '../server/api.ts';
import {
  SEED_CASES_DIR, caseFromFinding, compareEval, incidentCasesDir, evalReviewer, loadCases, matchedBugs, readBaseline, saveCase, scoreFindings, writeBaseline, answerCounts, caseSummary,
  type ReviewCase,
} from './eval.ts';
import { pickReviewers } from './gate.ts';
import { addFindings, answerFinding, createReview } from './store.ts';
import { diffLinesFromUnified } from './triage.ts';
import { fingerprint } from './types.ts';
import type { Finding, Severity } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const seedDir = join(repoRoot, 'eval', 'review');
const fakeExe = { cmd: process.execPath, prefix: [join(here, '..', 'adapters', 'fake-agent.mjs')] };
const SECRET = 'sk-' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4';   // built at runtime: no secret-looking literal in the repo

const root = mkdtempSync(join(tmpdir(), 'hub-evalrev-'));
after(() => { rmSync(root, { recursive: true, force: true }); });
let n = 0;
const sub = (): string => { const d = join(root, `t${++n}`); mkdirSync(d, { recursive: true }); return d; };

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n export const a = 1;\n+export const b = 2;\n+for (let i = 0; i <= n; i++) {}\n export const c = 3;\n';
const caseOf = (over: Partial<ReviewCase> = {}): ReviewCase => ({ id: 'c1', title: 'Loop bound', kind: 'buggy', diff: DIFF, bugs: [{ file: 'src/a.ts', line: 3 }], ...over });
const fnd = (file: string, line: number, severity: Severity = 'important'): Finding => ({
  id: `fd${line}${file.length}`, fingerprint: fingerprint({ file, title: 't' }, String(line)), reviewId: 'eval', round: 1, severity, lens: 'correctness', file, line, title: 't', evidence: 'e', votes: { real: 2, notReal: 0 }, answer: 'open',
});
const writeCase = (dir: string, id: string, json: unknown, diff: string | null = DIFF): void => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'case.json'), typeof json === 'string' ? json : JSON.stringify(json));
  if (diff !== null) writeFileSync(join(dir, id, 'case.diff'), diff);
};

// ---- seed cases --------------------------------------------------------------------------------------------------------------------

test('seed cases: 6 synthetic cases (4 buggy, 2 clean) load, and every known bug line lies inside its own diff', () => {
  const skipped: string[] = [];
  const cases = loadCases(seedDir, skipped);
  assert.deepEqual(skipped, []);
  assert.equal(cases.length, 6);
  assert.equal(cases.filter((c) => c.kind === 'buggy').length, 4); assert.equal(cases.filter((c) => c.kind === 'clean').length, 2);
  for (const c of cases) {
    assert.equal(c.source, 'seed');
    const lines = diffLinesFromUnified(c.diff);
    assert.ok(lines.size > 0, `${c.id}: the diff has added lines`);
    if (c.kind === 'clean') assert.deepEqual(c.bugs, [], `${c.id}: a clean case has no known bugs`);
    for (const b of c.bugs) assert.ok(lines.has(`${b.file}:${b.line}`), `${c.id}: bug ${b.file}:${b.line} is not an added line of the diff`);
  }
  assert.deepEqual(caseSummary(seedDir), { total: 6, seed: 6, incident: 0, buggy: 4, clean: 2 });
});

// ---- loading ---------------------------------------------------------------------------------------------------------------------------

test('loadCases: traversal ids, id/folder mismatch, malformed JSON, wrong shapes and oversized files are skipped with a reason; junk folders and files are tolerated', () => {
  const dir = sub();
  writeCase(dir, 'ok-case', { id: 'ok-case', title: 'T', kind: 'buggy', bugs: [{ file: 'src/a.ts', line: 3 }] });
  writeCase(dir, 'mismatch', { id: 'other', title: 'T', kind: 'clean', bugs: [] });
  writeCase(dir, 'trav', { id: '../evil', title: 'T', kind: 'clean', bugs: [] });
  writeCase(dir, 'bad-json', '{not json');
  writeCase(dir, 'no-bugs', { id: 'no-bugs', title: 'T', kind: 'buggy', bugs: [] });
  writeCase(dir, 'clean-with-bug', { id: 'clean-with-bug', title: 'T', kind: 'clean', bugs: [{ file: 'src/a.ts', line: 3 }] });
  writeCase(dir, 'bad-kind', { id: 'bad-kind', title: 'T', kind: 'maybe', bugs: [] });
  writeCase(dir, 'bad-bug-file', { id: 'bad-bug-file', title: 'T', kind: 'buggy', bugs: [{ file: '../../etc/passwd', line: 1 }] });
  writeCase(dir, 'bad-bug-line', { id: 'bad-bug-line', title: 'T', kind: 'buggy', bugs: [{ file: 'src/a.ts', line: 0 }] });
  writeCase(dir, 'huge-diff', { id: 'huge-diff', title: 'T', kind: 'clean', bugs: [] }, 'x'.repeat(200 * 1024 + 1));
  writeCase(dir, 'empty-diff', { id: 'empty-diff', title: 'T', kind: 'clean', bugs: [] }, '  \n');
  writeCase(dir, 'no-diff-file', { id: 'no-diff-file', title: 'T', kind: 'clean', bugs: [] }, null);
  writeCase(dir, 'huge-json', JSON.stringify({ id: 'huge-json', title: 'T'.repeat(70_000), kind: 'clean', bugs: [] }));
  writeCase(dir, 'Bad Name', { id: 'Bad Name', title: 'T', kind: 'clean', bugs: [] });
  mkdirSync(join(dir, 'empty-folder')); writeFileSync(join(dir, 'stray.txt'), 'x');
  const skipped: string[] = [];
  const cases = loadCases(dir, skipped);
  assert.deepEqual(cases.map((c) => c.id), ['ok-case']);
  assert.equal(skipped.length, 14, skipped.join('\n'));
  assert.ok(skipped.some((s) => s.startsWith('trav:')) && skipped.some((s) => s.startsWith('huge-diff:')) && skipped.some((s) => s.startsWith('bad-json:')));
  assert.deepEqual(loadCases(join(dir, 'does-not-exist')), [], 'a missing folder is no cases');
});

test('loadCases: a symlinked case file is not followed (skipped)', (t) => {
  const dir = sub(); const outside = sub();
  writeFileSync(join(outside, 'secret.txt'), 'outside text');
  writeCase(dir, 'link-diff', { id: 'link-diff', title: 'T', kind: 'clean', bugs: [] }, null);
  try { symlinkSync(join(outside, 'secret.txt'), join(dir, 'link-diff', 'case.diff')); } catch { t.skip('symlinks are not allowed here'); return; }
  const skipped: string[] = [];
  assert.deepEqual(loadCases(dir, skipped), []); assert.equal(skipped.length, 1);
});

// ---- scoring ---------------------------------------------------------------------------------------------------------------------------

test('matchedBugs: a finding matches a bug at exactly 3 lines, misses at 4, in another file, and a nit, a pre-existing finding or an answered-away severity does not count', () => {
  const bug = { file: 'src/a.ts', line: 10 };
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 13)]), 1, 'exactly +3');
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 7)]), 1, 'exactly -3');
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 14)]), 0, '4 lines away');
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 6)]), 0, '4 lines away (before)');
  assert.equal(matchedBugs([bug], [fnd('src/b.ts', 10)]), 0, 'wrong file');
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 10, 'nit')]), 0, 'a nit is not a real bug');
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 10, 'pre-existing')]), 0, 'pre-existing is not the author\'s bug');
  assert.equal(matchedBugs([bug], [fnd('src/a.ts', 10, 'security')]), 1, 'a security finding counts');
  assert.equal(matchedBugs([bug], [fnd('./src\\a.ts', 10)]), 1, 'path spelling does not matter');
  assert.equal(matchedBugs([bug, { file: 'src/a.ts', line: 50 }], [fnd('src/a.ts', 11), fnd('src/a.ts', 12)]), 1, 'two findings on one bug are one found bug');
  assert.equal(matchedBugs([], [fnd('src/a.ts', 10)]), 0);
});

test('scoreFindings: recall = found real bugs / known bugs over all cases; noise = Important/Security findings on clean cases per clean case', () => {
  const cases: ReviewCase[] = [
    caseOf({ id: 'b1', bugs: [{ file: 'src/a.ts', line: 3 }, { file: 'src/a.ts', line: 40 }] }),
    caseOf({ id: 'b2', bugs: [{ file: 'src/z.ts', line: 7 }] }),
    caseOf({ id: 'k1', kind: 'clean', bugs: [] }), caseOf({ id: 'k2', kind: 'clean', bugs: [] }),
  ];
  const s = scoreFindings(cases, { b1: [fnd('src/a.ts', 4)], b2: [fnd('src/z.ts', 20)], k1: [fnd('src/a.ts', 2), fnd('src/a.ts', 3, 'security'), fnd('src/a.ts', 1, 'nit'), fnd('src/a.ts', 1, 'pre-existing')], k2: [] });
  assert.equal(s.recall, 1 / 3, '1 of 3 known bugs found');
  assert.equal(s.noiseOnClean, 1, '2 blocking findings / 2 clean cases; the nit and the pre-existing one are not noise');
  const none = scoreFindings([caseOf({ id: 'k', kind: 'clean', bugs: [] })], { k: [] });
  assert.equal(none.recall, 1, 'no known bugs: nothing was missed'); assert.equal(none.noiseOnClean, 0);
  assert.equal(scoreFindings([caseOf({ id: 'b' })], {}).recall, 0, 'a case that was not run found nothing');
});

test('compareEval: recall lower than the baseline fails; equal or higher passes; the tolerance is respected', () => {
  const base = { recall: 0.75, noiseOnClean: 0.5, roundsToPass: 1.5 };
  assert.deepEqual(compareEval(base, { ...base }), { ok: true });
  assert.deepEqual(compareEval(base, { ...base, recall: 1 }), { ok: true });
  const worse = compareEval(base, { ...base, recall: 0.5 });
  assert.equal(worse.ok, false); assert.match(worse.ok ? '' : worse.why, /recall/i); assert.match(worse.ok ? '' : worse.why, /50%/);
  assert.equal(compareEval(base, { ...base, recall: 0.7 }, 0.1).ok, true, 'within tolerance');
  assert.equal(compareEval(base, { ...base, recall: 0.6 }, 0.1).ok, false);
  assert.equal(compareEval(base, { ...base, recall: Number.NaN }).ok, false, 'an unreadable number is a failure, not a pass');
  assert.equal(compareEval(base, { ...base, noiseOnClean: 9 }).ok, true, 'noise is reported, only recall gates');
});

test('baseline file: round trip; garbage, missing and out-of-range files read as no baseline', () => {
  const dir = sub(); const p = join(dir, 'nested', 'review-eval-baseline.json');
  assert.equal(readBaseline(p), null);
  writeBaseline(p, { recall: 0.75, noiseOnClean: 0.5, roundsToPass: 1.5, effort: 'quick', cases: 6, savedAt: '2026-10-26T10:00:00.000Z' });
  assert.deepEqual(readBaseline(p), { recall: 0.75, noiseOnClean: 0.5, roundsToPass: 1.5, effort: 'quick', cases: 6, savedAt: '2026-10-26T10:00:00.000Z' });
  for (const bad of ['{nope', '[]', JSON.stringify({ recall: 2, noiseOnClean: 0, roundsToPass: 1, effort: 'quick', cases: 1, savedAt: 'x' }), JSON.stringify({ recall: 'a' })]) { writeFileSync(p, bad); assert.equal(readBaseline(p), null, bad); }
});

// ---- saving incidents as cases ---------------------------------------------------------------------------------------------------

test('saveCase: sanitises the id, writes case.json + case.diff, redacts a secret in the diff, refuses to overwrite', () => {
  const dir = sub();
  const saved = saveCase(dir, caseOf({ id: ' My Case/../Loop! ', diff: DIFF.replace('export const b = 2;', `export const b = "${SECRET}";`), source: 'incident' }));
  assert.equal(saved.id, 'my-case-loop');
  assert.deepEqual(readdirSync(join(dir, 'my-case-loop')).sort(), ['case.diff', 'case.json']);
  const diffOnDisk = readFileSync(join(dir, 'my-case-loop', 'case.diff'), 'utf8');
  assert.ok(!diffOnDisk.includes(SECRET) && diffOnDisk.includes('[REDACTED'), 'the secret is gone');
  const json = JSON.parse(readFileSync(join(dir, 'my-case-loop', 'case.json'), 'utf8')) as Record<string, unknown>;
  assert.ok(!('diff' in json), 'the diff lives only in case.diff'); assert.equal(json['source'], 'incident');
  assert.equal(loadCases(dir).length, 1, 'what was saved loads back');
  assert.throws(() => saveCase(dir, caseOf({ id: 'my-case-loop' })), /already exists/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'my-case-loop', 'case.json'), 'utf8')).title, 'Loop bound', 'the first case is untouched');
});

test('saveCase: refuses an empty id, an oversized diff, a bug that is not in the diff, a clean case with bugs and a buggy one without', () => {
  const dir = sub();
  assert.throws(() => saveCase(dir, caseOf({ id: '../..' })), /id/i);
  assert.throws(() => saveCase(dir, caseOf({ id: 'big', diff: 'x'.repeat(200 * 1024 + 1) })), /200 KB|too large/i);
  assert.throws(() => saveCase(dir, caseOf({ id: 'far', bugs: [{ file: 'src/a.ts', line: 90 }] })), /not in the diff|diff/i);
  assert.throws(() => saveCase(dir, caseOf({ id: 'otherfile', bugs: [{ file: 'src/other.ts', line: 3 }] })), /diff/i);
  assert.throws(() => saveCase(dir, caseOf({ id: 'cleanbug', kind: 'clean' })), /clean/i);
  assert.throws(() => saveCase(dir, caseOf({ id: 'nobugs', bugs: [] })), /bug/i);
  assert.throws(() => saveCase(dir, caseOf({ id: 'baddiff', diff: '   ' })), /diff/i);
  assert.deepEqual(readdirSync(dir), [], 'nothing half-written');
});

test('caseFromFinding: a buggy incident case with only the diff of the finding\'s file, a stable id from the title and a redacted brief', () => {
  const two = `${DIFF}diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y\n`;
  const c = caseFromFinding({ title: 'Reopened: loop bound!', diff: two, file: 'src/a.ts', line: 3, brief: `use key ${SECRET}` });
  assert.match(c.id, /^reopened-loop-bound-[0-9a-f]{6}$/);
  assert.equal(c.kind, 'buggy'); assert.equal(c.source, 'incident'); assert.deepEqual(c.bugs, [{ file: 'src/a.ts', line: 3 }]);
  assert.ok(c.diff.includes('src/a.ts') && !c.diff.includes('src/other.ts'));
  assert.equal(caseFromFinding({ title: 'Reopened: loop bound!', diff: two, file: 'src/a.ts', line: 3 }).id, c.id, 'same input, same id');
  const dir = sub(); const saved = saveCase(dir, c);
  assert.ok(!readFileSync(join(dir, saved.id, 'case.json'), 'utf8').includes(SECRET), 'the brief is redacted too');
});

// ---- the reviewer pipeline on cases (fake agent) -------------------------------------------------------------------------------

interface F { category: string; file: string; line: number; title: string; evidence: string; classOfBug: string }
function runsWith(script: { hunt: Record<string, F[] | 'prose'>; verify?: 'real' | 'notreal' }): RunManager {
  const dir = sub(); const scriptFile = join(dir, 'script.json'); writeFileSync(scriptFile, JSON.stringify({ verify: 'real', ...script }));
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_SCENARIO: 'review-script', FAKE_REVIEW_SCRIPT: scriptFile };
  return new RunManager(openDb(':memory:'), { exe: { claude: fakeExe, codex: fakeExe }, env, summarize: false, home: join(dir, 'home') });
}
const bugFinding = (file: string, line: number, title = 'Off-by-one in loop bound'): F => ({ category: 'bug', file, line, title, evidence: 'for (let i = 0; i <= n; i++)', classOfBug: 'off-by-one' });
const picks = pickReviewers('quick', ['claude'])!;

test('evalReviewer (fake agent): finds the planted bug in the buggy case and reports nothing on the clean one; rounds, recall and noise follow', async () => {
  const cases = loadCases(seedDir).filter((c) => c.id === 'off-by-one-loop' || c.id === 'harmless-refactor');
  assert.equal(cases.length, 2);
  const bug = cases.find((c) => c.kind === 'buggy')!.bugs[0]!;
  const runs = runsWith({ hunt: { correctness: [bugFinding(bug.file, bug.line + 1)] } });   // one line off: inside the ±3 window
  const r = await evalReviewer({ cases, effort: 'quick', runs, picks });
  assert.equal(r.recall, 1);
  assert.equal(r.noiseOnClean, 0, 'a finding in a file the clean diff does not touch is pre-existing, not noise');
  assert.equal(r.roundsToPass, 1.5, 'buggy case: 1 round to find + 1 to see no new blocking finding; clean case: 1');
  assert.deepEqual(r.byAnswer, { open: 0, fixed: 0, rejected: 0, intentional: 0, dismissed: 0 }, 'no db given: zeros');
  assert.deepEqual(r.cases.map((c) => [c.id, c.found, c.blocking]).sort(), [['harmless-refactor', 0, 0], ['off-by-one-loop', 1, 1]]);
});

test('evalReviewer (fake agent): a reviewer that flags a clean diff is noise; one that misses the bug has recall 0; a verifier that says "not real" removes the finding', async () => {
  const cases = loadCases(seedDir).filter((c) => c.id === 'off-by-one-loop' || c.id === 'harmless-refactor');
  const clean = cases.find((c) => c.kind === 'clean')!;
  const added = [...diffLinesFromUnified(clean.diff)][0]!; const [cf, cl] = [added.slice(0, added.lastIndexOf(':')), Number(added.slice(added.lastIndexOf(':') + 1))];
  const noisy = await evalReviewer({ cases, effort: 'quick', runs: runsWith({ hunt: { correctness: [bugFinding(cf, cl, 'Imagined problem')] } }), picks });
  assert.equal(noisy.noiseOnClean, 1); assert.equal(noisy.recall, 0, 'the finding was in the clean file, the bug was not found');
  const dropped = await evalReviewer({ cases, effort: 'quick', runs: runsWith({ hunt: { correctness: [bugFinding(cf, cl)] }, verify: 'notreal' }), picks });
  assert.equal(dropped.noiseOnClean, 0, 'not confirmed by the verifier: never a finding');
});

test('evalReviewer: a reviewer that fails stops the evaluation (never counted as "found nothing"); no usable reviewer is an error that says sign in first', async () => {
  const cases = loadCases(seedDir).slice(0, 1);
  await assert.rejects(evalReviewer({ cases, effort: 'quick', runs: runsWith({ hunt: { correctness: 'prose' } }), picks }), /structured/);
  await assert.rejects(evalReviewer({ cases, effort: 'quick', runs: runsWith({ hunt: {} }), available: [] }), /sign in first/);
});

test('evalReviewer: leaves no temp folder behind', async () => {
  const before = readdirSync(tmpdir()).filter((x) => x.startsWith('hub-evalrev-') || x.startsWith('hub-evalcwd-')).length;
  await evalReviewer({ cases: loadCases(seedDir).filter((c) => c.kind === 'clean').slice(0, 1), effort: 'quick', runs: runsWith({ hunt: {} }), picks });
  assert.equal(readdirSync(tmpdir()).filter((x) => x.startsWith('hub-evalrev-') || x.startsWith('hub-evalcwd-')).length, before);
});

test('answerCounts: counts the answers over stored findings (zeros without a db)', () => {
  assert.deepEqual(answerCounts(), { open: 0, fixed: 0, rejected: 0, intentional: 0, dismissed: 0 });
  const db = openDb(':memory:');
  const rv = createReview(db, { runId: 'r1', projectId: 1, baseSha: 'a', headSha: 'b', effort: 'quick', risk: 'low', round: 1, state: 'open' });
  const mk = (title: string): Parameters<typeof addFindings>[3][number] => ({ lens: 'correctness', file: 'a.ts', line: 1, title, evidence: 'e', category: 'bug', severity: 'important', fingerprint: fingerprint({ file: 'a.ts', title }, title), votes: { real: 2, notReal: 0 } });
  const stored = addFindings(db, rv.id, 1, [mk('one'), mk('two'), mk('three')]);
  answerFinding(db, stored[0]!.id, 'rejected', 'not a bug'); answerFinding(db, stored[1]!.id, 'intentional', 'by design');
  assert.deepEqual(answerCounts(db), { open: 1, fixed: 0, rejected: 1, intentional: 1, dismissed: 0 });
});

// ---- the API --------------------------------------------------------------------------------------------------------------------------

function apiWorld(): { ctx: Ctx; casesDir: string; seedDir: string; baselinePath: string; call: (m: string, p: string, body?: Record<string, unknown>) => ReturnType<typeof handle> } {
  const dir = sub(); const casesDir = join(dir, 'cases'); const seedDir = join(dir, 'seeds'); const baselinePath = join(dir, 'home', 'review-eval-baseline.json');
  const db = openDb(':memory:');
  const ctx: Ctx = { db, runs: new RunManager(db, { exe: { claude: fakeExe, codex: fakeExe }, summarize: false, home: join(dir, 'home') }), reviewEval: { casesDir, seedDir, baselinePath } };
  return { ctx, casesDir, seedDir, baselinePath, call: (m, p, body = {}) => handle(ctx, m, p, new URLSearchParams(), body) };
}

test('GET /api/review-eval: counts and the baseline, never a diff; "no baseline" is null', async () => {
  const w = apiWorld();
  let r = await w.call('GET', '/api/review-eval');
  assert.equal(r.status, 200); assert.deepEqual(r.json, { baseline: null, cases: { total: 0, seed: 0, incident: 0, buggy: 0, clean: 0 } });
  saveCase(w.casesDir, caseOf({ id: 'one', source: 'seed' })); saveCase(w.casesDir, caseOf({ id: 'two', kind: 'clean', bugs: [], source: 'incident' }));
  writeBaseline(w.baselinePath, { recall: 0.5, noiseOnClean: 0, roundsToPass: 1, effort: 'standard', cases: 2, savedAt: '2026-10-26T10:00:00.000Z' });
  r = await w.call('GET', '/api/review-eval');
  assert.deepEqual((r.json as { cases: unknown }).cases, { total: 2, seed: 1, incident: 1, buggy: 1, clean: 1 });
  assert.equal((r.json as { baseline: { recall: number } }).baseline.recall, 0.5);
  assert.ok(!JSON.stringify(r.json).includes('export const'), 'no diff text');
});

test('POST /api/review-eval/cases: refuses bad input; saves from text with a redacted diff; a repeat is 409', async () => {
  const w = apiWorld();
  const ok = { title: 'Loop bound', diffFrom: 'text', diff: DIFF, file: 'src/a.ts', line: 3 };
  const status = async (body: Record<string, unknown>): Promise<number> => (await w.call('POST', '/api/review-eval/cases', body)).status;
  assert.equal(await status({ ...ok, title: '' }), 400, 'title');
  assert.equal(await status({ ...ok, title: 'x'.repeat(201) }), 400, 'long title');
  assert.equal(await status({ ...ok, diffFrom: 'path' }), 400, 'unknown source');
  assert.equal(await status({ ...ok, diffFrom: undefined }), 400);
  assert.equal(await status({ ...ok, file: '' }), 400, 'file');
  assert.equal(await status({ ...ok, file: '../../etc/passwd' }), 400, 'path traversal');
  assert.equal(await status({ ...ok, line: 0 }), 400); assert.equal(await status({ ...ok, line: 'x' }), 400); assert.equal(await status({ ...ok, line: 1.5 }), 400);
  assert.equal(await status({ ...ok, diff: undefined }), 400, 'no diff');
  assert.equal(await status({ ...ok, diff: 'x'.repeat(200 * 1024 + 1) }), 400, 'too big');
  assert.equal(await status({ ...ok, line: 99 }), 400, 'bug line outside the diff');
  assert.equal(await status({ ...ok, diffFrom: 'review', reviewId: '../x' }), 404, 'bad review id');
  assert.equal(await status({ ...ok, diffFrom: 'review', reviewId: 'rvabc123' }), 404, 'unknown review');
  assert.deepEqual(existsSync(w.casesDir) ? readdirSync(w.casesDir) : [], [], 'nothing saved by the refusals');
  const saved = await w.call('POST', '/api/review-eval/cases', { ...ok, diff: DIFF.replace('export const b = 2;', `export const b = "${SECRET}";`) });
  assert.equal(saved.status, 200);
  const id = (saved.json as { id: string }).id; assert.match(id, /^loop-bound-[0-9a-f]{6}$/);
  assert.ok(!readFileSync(join(w.casesDir, id, 'case.diff'), 'utf8').includes(SECRET));
  assert.equal(JSON.parse(readFileSync(join(w.casesDir, id, 'case.json'), 'utf8')).source, 'incident');
  assert.equal(await status({ ...ok, diff: DIFF.replace('export const b = 2;', `export const b = "${SECRET}";`) }), 409, 'the same incident twice');
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('POST /api/review-eval/cases from a review finding: the server reads the review\'s own diff (no path from the request reaches git); a finding of another review is refused', async () => {
  const w = apiWorld(); const db = w.ctx.db;
  const repo = join(sub(), 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const c = 3;\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\nfor (let i = 0; i <= n; i++) {}\nexport const c = 3;\n'); writeFileSync(join(repo, 'src', 'other.ts'), 'x\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'work']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const pid = projectId(db, repo) as number;
  db.prepare('INSERT INTO run (id, project_id, agent, prompt, cwd, branch, started_at, ended_at, outcome, base_sha, permission, work_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('rev1', pid, 'claude', `Fix the loop (key ${SECRET})`, repo, 'hub/t/claude', '2026-10-26T10:00:00Z', '2026-10-26T10:05:00Z', 'review', base, 'edit', null);
  const rv = createReview(db, { runId: 'rev1', projectId: pid, baseSha: base, headSha: head, effort: 'quick', risk: 'low', round: 1, state: 'open' });
  const rv2 = createReview(db, { runId: 'rev1', projectId: pid, baseSha: base, headSha: head, effort: 'quick', risk: 'low', round: 1, state: 'open' });
  const mk = (line: number): Parameters<typeof addFindings>[3][number] => ({ lens: 'correctness', file: 'src/a.ts', line, title: 'Off-by-one', evidence: 'i <= n', category: 'bug', severity: 'important', fingerprint: fingerprint({ file: 'src/a.ts', title: 'Off-by-one' }, `l${line}`), votes: { real: 2, notReal: 0 } });
  const f1 = addFindings(db, rv.id, 1, [mk(3)])[0]!; const f2 = addFindings(db, rv2.id, 1, [{ ...mk(3), fingerprint: 'other' }])[0]!;

  assert.equal((await w.call('POST', '/api/review-eval/cases', { title: 'x', diffFrom: 'review', reviewId: rv.id, findingId: f2.id })).status, 404, 'the finding belongs to another review');
  assert.equal((await w.call('POST', '/api/review-eval/cases', { title: 'x', diffFrom: 'review', reviewId: rv.id })).status, 400, 'a finding is required');
  assert.equal((await w.call('POST', '/api/review-eval/cases', { title: 'x', diffFrom: 'review', reviewId: rv.id, findingId: 'nope' })).status, 404);
  const r = await w.call('POST', '/api/review-eval/cases', { title: 'Reopened loop bound', diffFrom: 'review', reviewId: rv.id, findingId: f1.id, file: '../../x', line: 77 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = (r.json as { id: string }).id;
  const diff = readFileSync(join(w.casesDir, id, 'case.diff'), 'utf8');
  assert.ok(diff.includes('+for (let i = 0; i <= n; i++) {}') && !diff.includes('other.ts'), 'only the finding\'s file');
  const json = JSON.parse(readFileSync(join(w.casesDir, id, 'case.json'), 'utf8')) as { bugs: { file: string; line: number }[]; brief: string; kind: string };
  assert.deepEqual(json.bugs, [{ file: 'src/a.ts', line: 3 }], 'file and line come from the finding, not from the request');
  assert.ok(!json.brief.includes(SECRET) && json.brief.includes('Fix the loop'), 'the task prompt is the brief, redacted');
  assert.equal(loadCases(w.casesDir).length, 1);
});

// ---- the CLI --------------------------------------------------------------------------------------------------------------------------

/** An environment in which no agent CLI can be found: a live run must stop at the sign-in check, never start a review. */
function bareEnv(): NodeJS.ProcessEnv {
  const empty = sub();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(path|localappdata|appdata|userprofile|home|agent_hub_home)$/i.test(k)) env[k] = v;
  return { ...env, PATH: empty, LOCALAPPDATA: join(empty, 'l'), APPDATA: join(empty, 'a'), USERPROFILE: empty, HOME: empty, AGENT_HUB_HOME: join(empty, 'hub') };
}
const hub = (args: string[], env = bareEnv()): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repoRoot, 'bin', 'hub.js'), 'review-eval', ...args], { encoding: 'utf8', env, windowsHide: true, timeout: 60_000 });

test('hub review-eval --dry lists the seed cases and runs nothing', () => {
  const r = hub(['--dry']);
  assert.equal(r.status, 0, r.stderr);
  for (const id of ['off-by-one-loop', 'missing-input-check', 'swallowed-error', 'unescaped-shell-input', 'harmless-refactor', 'comment-only-change']) assert.ok(r.stdout.includes(id), id);
  assert.match(r.stdout, /4 buggy/); assert.match(r.stdout, /2 clean/);
});

test('hub review-eval without a signed-in reviewer prints "sign in first" and exits non-zero (no review is started)', () => {
  const r = hub(['--effort', 'quick']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /sign in first/i);
  const bad = hub(['--effort', 'turbo', '--dry']);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /effort/i);
});

test('incident cases are written under the hub home, never into the hub repo; the CLI and the API read seeds + incidents', async () => {
  const env = bareEnv(); const home = env['AGENT_HUB_HOME'] as string;
  const dir = incidentCasesDir(home);
  assert.ok(dir.startsWith(home) && !dir.startsWith(repoRoot), dir);
  assert.equal(SEED_CASES_DIR.toLowerCase(), seedDir.toLowerCase());
  saveCase(dir, caseOf({ id: 'my-incident', source: 'incident' }));
  const r = hub(['--dry'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /my-incident/); assert.match(r.stdout, /1 incident/); assert.match(r.stdout, /6 seed/);
  // API: POST writes into the incident folder only; GET counts both folders
  const w = apiWorld();
  saveCase(w.seedDir, caseOf({ id: 'a-seed', source: 'seed' }));
  const p = await w.call('POST', '/api/review-eval/cases', { title: 'From text', diffFrom: 'text', diff: DIFF, file: 'src/a.ts', line: 3 });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(loadCases(w.casesDir).length, 1); assert.equal(loadCases(w.seedDir).length, 1, 'the seed folder is not written');
  assert.deepEqual(((await w.call('GET', '/api/review-eval')).json as { cases: unknown }).cases, { total: 2, seed: 1, incident: 1, buggy: 2, clean: 0 });
});

test('hub review-eval --compare without a saved baseline fails before any spend', () => {
  const r = hub(['--compare']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /baseline/i);
});
