import { fingerprint } from './types.ts';
import type { Finding, Severity, VerifiedFinding } from './types.ts';

export interface TriageOpts {
  /** `"<file>:<line>"` for every line the diff ADDED or CHANGED (new-file numbering, forward slashes). */
  diffLines: Set<string>;
  maxNits: number;
  /** Fingerprints already shown in earlier rounds. */
  posted: Set<string>;
  reviewId: string;
  round: number;
  /** Text of the line a finding points at; the fingerprint needs it. A throwing lookup counts as empty text. */
  lineText: (file: string, line: number) => string;
  /** Repository root: an absolute finding path under it is made relative. */
  root?: string;
}

/** How far (in lines) a hunter's line number may be off and still count as the added line. */
export const LINE_SLACK = 3;
const WIN = process.platform === 'win32';
const fold = (s: string): string => (WIN ? s.toLowerCase() : s);

/** A hunter's path as a repository path: forward slashes, no leading `./`, an absolute path under `root` made relative. */
export function relFile(f: string, root?: string): string {
  let p = f.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (fold(p).startsWith(fold(r))) p = p.slice(r.length).replace(/^(?:\.\/)+/, '');
  }
  return p;
}

/** `"<file>:<line>"` keys → per-file line lists keyed by the folded path (case-insensitive on Windows), keeping the diff's own spelling. */
export function indexDiff(keys: Set<string>): Map<string, { file: string; lines: number[] }> {
  const m = new Map<string, { file: string; lines: number[] }>();
  for (const k of keys) {
    const i = k.lastIndexOf(':'); if (i <= 0) continue;
    const file = k.slice(0, i), line = Number(k.slice(i + 1));
    if (!Number.isSafeInteger(line)) continue;
    const key = fold(file); let e = m.get(key);
    if (!e) m.set(key, (e = { file, lines: [] }));
    e.lines.push(line);
  }
  return m;
}

/**
 * The diff's spelling of a finding's file (an `a/` / `b/` prefix is dropped only when that names a changed file), whether its line is added
 * give or take LINE_SLACK, and the ADDED line it matched (the nearest one; the hunter's own number when nothing matched). The slack is for
 * matching only: the stored line and its text are the matched added line, so clearing follows the right line.
 */
export function matchDiff(idx: Map<string, { file: string; lines: number[] }>, file: string, line: number): { file: string; inDiff: boolean; line: number } {
  let found: { file: string; lines: number[] } | undefined;
  for (const cand of [file, file.replace(/^[ab]\//, '')]) {
    const e = idx.get(fold(cand)); if (!e) continue;
    const near = e.lines.filter((l) => Math.abs(l - line) <= LINE_SLACK).sort((a, b) => Math.abs(a - line) - Math.abs(b - line) || a - b)[0];
    if (near !== undefined) return { file: e.file, inDiff: true, line: near };
    found ??= e;
  }
  return { file: found?.file ?? file, inDiff: false, line };
}

const DROPPED = new Set(['style', 'cleanup', 'diagnostic']);
const ORDER: Record<Severity, number> = { security: 0, important: 1, nit: 2, 'pre-existing': 3 };
const MAX_FILE = 1024;

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * Filter and tag verified findings. Never throws on hostile input: unusable findings are dropped, long strings are clipped.
 * - style / cleanup / diagnostic (and unknown categories) are dropped.
 * - A finding on a line the diff did not add or change (give or take LINE_SLACK lines, after path normalisation) is `pre-existing`:
 *   it never blocks and is not the author's. The gate passes the lines added in the WHOLE base..head diff, not one round's. This holds for
 *   the security lens too: an old security problem on an untouched line is reported, but as pre-existing, not as a blocker.
 * - Security lens on a changed line -> `security`. Bug/risk on a changed line -> `important`, except a weakly supported risk
 *   (1 real vote, 0 against, not security) which is a `nit`. At most `maxNits` nits are kept, strongest first.
 * - Repeats (fingerprint already posted, or twice in this batch) are dropped.
 */
export function triage(found: VerifiedFinding[], o: TriageOpts): Finding[] {
  const seen = new Set<string>(o.posted);
  const kept: Finding[] = [];
  const idx = indexDiff(o.diffLines);
  for (const raw of Array.isArray(found) ? found : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.category !== 'string' || DROPPED.has(raw.category) || (raw.category !== 'bug' && raw.category !== 'risk')) continue;
    if (typeof raw.file !== 'string' || !raw.file || raw.file.length > MAX_FILE) continue;
    if (!Number.isSafeInteger(raw.line) || raw.line < 1) continue;
    const rel = relFile(raw.file, o.root);
    if (!rel) continue;
    const { file, inDiff, line } = matchDiff(idx, rel, raw.line);
    const lens = clip(raw.lens, 64);
    const votes = { real: count(raw.votes?.real), notReal: count(raw.votes?.notReal) };
    const severity: Severity = !inDiff ? 'pre-existing'
      : lens === 'security' ? 'security'
      : raw.category === 'risk' && votes.real === 1 && votes.notReal === 0 ? 'nit'
      : 'important';
    const title = clip(raw.title, 300), classOfBug = clip(raw.classOfBug, 200);
    let text = '';
    try { text = String(o.lineText(file, line) ?? ''); } catch { /* unreadable line: fingerprint on the rest */ }
    const fp = fingerprint({ file, title, ...(classOfBug ? { classOfBug } : {}) }, text.slice(0, 2000));
    if (seen.has(fp)) continue;
    seen.add(fp);
    kept.push({
      id: `fd-${fp.slice(0, 16)}`, fingerprint: fp, reviewId: o.reviewId, round: o.round, severity, lens, file, line,
      title, evidence: clip(raw.evidence, 4000), ...(classOfBug ? { classOfBug } : {}), votes, answer: 'open',
    });
  }
  const strength = (f: Finding): number => f.votes.real - f.votes.notReal;
  kept.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || strength(b) - strength(a) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line);
  let nits = 0;
  const cap = Math.max(0, Math.floor(o.maxNits));
  return kept.filter((f) => f.severity !== 'nit' || nits++ < cap);
}

/** C-style unquote of a git path (`"\321\204 x"`): octal escapes are UTF-8 bytes. An unterminated quote takes the rest. */
function unquote(s: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { t: 9, n: 10, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') break;
    if (c === '\\' && i + 1 < s.length) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      if (m) { bytes.push(parseInt(m[0], 8) & 0xff); i += m[0].length; continue; }
      const e = esc[s[i + 1]!];
      if (e !== undefined) { bytes.push(e); i++; continue; }
    }
    for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from a `+++ ` line: null for /dev/null. Strips the `b/` prefix and the tab-separated timestamp/space marker. */
function plusPath(rest: string): string | null {
  const p = rest.startsWith('"') ? unquote(rest) : rest.split('\t')[0]!;
  if (p === '/dev/null') return null;
  return p.startsWith('b/') ? p.slice(2) : p;
}

export interface DiffLine { file: string | null; op: '+' | '-' | ' '; line: number; text: string }

/**
 * Every line inside a hunk of a unified diff, with its file (new path, null for /dev/null), op, new-file number (0 for removals) and text.
 * Hunk line counts decide where a hunk ends, so an added line that reads `++ x` (shown as `+++ x`) is not mistaken for a file header.
 */
export function* unifiedLines(diffText: string): Generator<DiffLine> {
  let file: string | null = null;
  let oldLeft = 0, newLeft = 0, next = 0;
  for (const line of String(diffText).split(/\r?\n/)) {
    if (line.startsWith('diff ')) { file = null; oldLeft = newLeft = 0; continue; }
    if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) { oldLeft = newLeft = 0; continue; }
      oldLeft = m[1] === undefined ? 1 : Number(m[1]); next = Number(m[2]); newLeft = m[3] === undefined ? 1 : Number(m[3]);
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '+') { yield { file, op: '+', line: next, text: line.slice(1) }; next++; newLeft--; }
      else if (c === '-') { yield { file, op: '-', line: 0, text: line.slice(1) }; oldLeft--; }
      else if (c === '\\') { /* "\ No newline at end of file" */ }
      else { yield { file, op: ' ', line: next, text: line.slice(1) }; next++; oldLeft--; newLeft--; }
      continue;
    }
    if (line.startsWith('+++ ')) file = plusPath(line.slice(4));
  }
}

/** Lines ADDED or CHANGED by a unified diff, as `"<file>:<new line>"`. Pure deletions have no new line number and add nothing. */
export function diffLinesFromUnified(diffText: string): Set<string> {
  const out = new Set<string>();
  for (const l of unifiedLines(diffText)) if (l.op === '+' && l.file !== null) out.add(`${l.file}:${l.line}`);
  return out;
}
