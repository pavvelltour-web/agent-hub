import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { change, readText } from '../core/plan.ts';
import { REPO_ROOT } from '../core/registry.ts';
import type { FileChange } from '../core/types.ts';
import type { Db } from '../history/store.ts';
import { isSafeName, isSecretPath } from '../lib/paths.ts';
import { redact } from '../lib/redact.ts';

/** The five sections of every REVIEW.md, in order. The reviewer, the risk tier and the rule-drift action find their data by these headings. */
export const REVIEW_HEADINGS = ['Что здесь считается поломкой', 'Не проверять', 'Пути, где нужен человек', 'Лимит мелочей: 5', 'Доказательство: файл и строка'] as const;
const BROKEN = REVIEW_HEADINGS[0], HUMAN = REVIEW_HEADINGS[2];

const MAX_TOTAL = 40 * 1024;          // characters handed to the reviewer
const MAX_LINE = 300;                 // one appended rule
const MAX_FILE_EDIT = 200 * 1024;     // never rewrite a larger REVIEW.md through the API
const MAX_HUMAN_PATHS = 50;
const TRUNCATED = '\n[REVIEW.md truncated]\n';

// ---- template ------------------------------------------------------------------------------------------------------------------------

/** `templates/<type>/REVIEW.md`, or null for an unknown type. */
export function reviewTemplate(type: string): string | null {
  if (typeof type !== 'string' || !isSafeName(type)) return null;
  try { return readFileSync(join(REPO_ROOT, 'templates', type, 'REVIEW.md'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch { return null; }
}

/** The init-plan change that creates REVIEW.md for a project type. An existing REVIEW.md (even a dangling link) is never touched. */
export function compileReviewMd(root: string, type: string): FileChange[] {
  const tpl = reviewTemplate(type);
  if (tpl === null) return [];
  const target = join(root, 'REVIEW.md');
  try { lstatSync(target); return []; } catch { /* absent: create it */ }
  return [change(target, tpl, 'правила ревью, написанные для этого типа проекта')];
}

// ---- loading for the reviewer --------------------------------------------------------------------------------------------------------

const inside = (realRoot: string, p: string): boolean => { const r = relative(realRoot, p); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };

/** First `MAX_TOTAL` bytes of a regular file that really lives inside the project, redacted. Null when absent, not a file, or outside. */
function readInside(realRoot: string, file: string): { real: string; text: string } | null {
  let real: string;
  try { real = realpathSync(file); } catch { return null; }
  if (!inside(realRoot, real)) return null;
  let fd = -1;
  try {
    if (!statSync(real).isFile()) return null;
    fd = openSync(real, 'r');
    const buf = Buffer.alloc(MAX_TOTAL + 1);
    const got = readSync(fd, buf, 0, buf.length, 0);
    return { real, text: redact(buf.subarray(0, got).toString('utf8').replace(/^﻿/, '').replace(/�+$/, '')) };
  } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } }
}

/** Path segments of a changed path, or null when it is absolute, has a drive, `..`, NUL or is oversized. */
function segments(p: unknown): string[] | null {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return null;
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  return parts.includes('..') || !parts.length ? null : parts;
}

/**
 * The reviewer's checklist: the root REVIEW.md, then the NEAREST per-folder REVIEW.md of every changed path (walking up from the file; each file once).
 * Nothing outside `root` is ever read (traversal, absolute paths, links and junctions are ignored). Redacted and capped at ~40 KB.
 */
export function loadReviewMd(root: string, changedPaths: string[]): string {
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return ''; }
  const sections: string[] = [];
  const seen = new Set<string>();
  const take = (file: string, label: string | null): boolean => {
    const r = readInside(realRoot, file);
    if (!r) return false;
    const key = r.real.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    sections.push(label === null ? r.text : `--- REVIEW.md: ${label} ---\n${r.text}`);
    return true;
  };
  take(join(realRoot, 'REVIEW.md'), null);
  const nearest = new Map<string, string>();       // folder label -> file
  for (const p of Array.isArray(changedPaths) ? changedPaths : []) {
    const parts = segments(p);
    if (!parts) continue;
    const dirs = parts.slice(0, -1);
    for (let d = dirs.length; d >= 1; d--) {
      const rel = dirs.slice(0, d).join('/');
      if (isSecretPath(rel)) continue;
      const file = join(realRoot, ...dirs.slice(0, d), 'REVIEW.md');
      if (readInside(realRoot, file)) { nearest.set(rel, file); break; }
    }
  }
  for (const rel of [...nearest.keys()].sort()) take(nearest.get(rel) as string, rel);
  const out = sections.join('\n\n');
  return out.length > MAX_TOTAL ? out.slice(0, MAX_TOTAL) + TRUNCATED : out;
}

// ---- paths where a human is needed ---------------------------------------------------------------------------------------------------

const headingRe = (title: string): RegExp => new RegExp(`^#{1,6}\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*$`);
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;

/** Lines of the section under `title`, up to the next heading. */
function sectionLines(text: string, title: string): { lines: string[]; start: number; end: number } | null {
  const lines = String(text ?? '').split(/\r?\n/);
  const re = headingRe(title);
  const start = lines.findIndex((l) => re.test(l.trim()));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && ANY_HEADING.test(l));
  if (end < 0) end = lines.length;
  return { lines, start, end };
}

/** Globs listed as bullets under "Пути, где нужен человек". Anything that is not a plausible relative path or glob is ignored. */
export function humanPathsFromReviewMd(text: string): string[] {
  const sec = sectionLines(text, HUMAN);
  if (!sec) return [];
  const out: string[] = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = BULLET.exec(sec.lines[i] as string);
    if (!m) continue;
    let g = (m[1] as string).trim();
    const wrapped = /^`([^`]+)`$/.exec(g);
    if (wrapped) g = (wrapped[1] as string).trim();
    g = g.replace(/\\/g, '/');
    if (!g || g.length > 200 || /[\u0000-\u001f\u007f`]/.test(g) || !/[\p{L}\p{N}*?]/u.test(g)) continue;
    if (g.startsWith('/') || /^[a-z]:/i.test(g) || g.split('/').includes('..') || /:\s/.test(g) || (g.match(/ /g) ?? []).length > 3) continue;
    if (!out.includes(g)) out.push(g);
    if (out.length >= MAX_HUMAN_PATHS) break;
  }
  return out;
}

// ---- repeated bug classes -> a rule --------------------------------------------------------------------------------------------------

/** Bug classes that appeared at least `minCount` times in the project's reviews (all answers counted), most frequent first. */
export function repeatedFindings(db: Db, projectId: number, minCount = 3): { classOfBug: string; count: number }[] {
  const min = Number.isFinite(minCount) ? Math.max(1, Math.floor(minCount)) : 3;
  const rows = db.prepare(
    `SELECT trim(MIN(f.class_of_bug)) AS classOfBug, COUNT(*) AS count FROM finding f JOIN review r ON r.id = f.review_id
     WHERE r.project_id = ? AND f.class_of_bug IS NOT NULL AND trim(f.class_of_bug) <> ''
     GROUP BY lower(trim(f.class_of_bug)) HAVING COUNT(*) >= ? ORDER BY COUNT(*) DESC, lower(trim(f.class_of_bug))`,
  ).all(projectId, min) as unknown as { classOfBug: string; count: number }[];
  return rows.map((r) => ({ classOfBug: String(r.classOfBug), count: Number(r.count) }));
}

/** A one-line rule in plain Russian. The bug class is quoted data: one line, no backticks, no markup characters, at most 120 characters. */
export function suggestRuleLine(classOfBug: string): string {
  const cls = redact(String(classOfBug ?? '')).replace(/[`<>[\]\p{Zl}\p{Zp}]|[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  return `Считать поломкой: «${cls}» — этот класс ошибок уже не раз находили в ревью этого проекта.`;
}

/**
 * The plan change that appends `line` as a bullet under "Что здесь считается поломкой" in the project's REVIEW.md.
 * Pure: writes nothing. The caller applies it through applyPlan (approval + backup + undo).
 */
export function appendRuleChange(root: string, line: string): FileChange {
  const raw = typeof line === 'string' ? line.trim().replace(/^[-*]\s+/, '') : '';
  if (!raw || raw.length > MAX_LINE || /[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u.test(raw)) throw new Error(`rule line must be 1-${MAX_LINE} characters on a single line`);
  const bullet = `- ${redact(raw)}`;
  const file = join(root, 'REVIEW.md');
  let st; try { st = lstatSync(file); } catch { throw new Error('REVIEW.md not found in this project: run init first'); }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_EDIT) throw new Error('REVIEW.md is not a regular file of a sane size');
  const before = readText(file);
  if (before === null) throw new Error('REVIEW.md not readable');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = before.split(/\r?\n/);
  if (lines.some((l) => l.trim() === bullet)) throw new Error('this rule line is already in REVIEW.md');
  const sec = sectionLines(before, BROKEN);
  let after: string;
  if (!sec) {
    after = before.replace(/\s*$/, '') + eol + eol + `## ${BROKEN}` + eol + bullet + eol;
  } else {
    let last = sec.start;
    for (let i = sec.start + 1; i < sec.end; i++) if ((lines[i] as string).trim()) last = i;
    const prevIsBullet = last > sec.start && BULLET.test(lines[last] as string);
    lines.splice(last + 1, 0, ...(prevIsBullet ? [bullet] : ['', bullet]));
    after = lines.join(eol);
  }
  return { path: file, action: 'update', before, after, note: 'новое правило ревью' };
}

export const reviewMdExists = (root: string): boolean => existsSync(join(root, 'REVIEW.md'));
