import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { isSafeName } from '../lib/paths.ts';
import { MAX_FILE, MAX_FILES, MAX_TOTAL, makeTextFetcher, relOk, type TextFetcher } from './install-remote.ts';
import { pathProblem } from '../review/checks.ts';
import { applyPlan, change, effective, undoBackup, type ApplyResult } from './plan.ts';
import { HUB_HOME, REPO_ROOT, library } from './registry.ts';
import type { Plan } from './types.ts';

/**
 * Starter kit: a short list of skills the hub offers on first run, installed into the hub LIBRARY (`HUB_HOME/skills`), where they cost no tokens
 * until a project links them. `registry/starter.json` is data, not a command: the hub fetches only from the repositories named there, only at the
 * commit pinned there (a 40-hex sha; an entry without one is `unpinned` and is never fetched), shows every byte, and writes what the user approved
 * by digest. Nothing is run, nothing is written outside the library, existing folders are never touched (ADR-022).
 */
export type StarterSource =
  | { type: 'github'; repo: string; path: string; ref: string }
  | { type: 'unpinned'; repo: string; path: string; note: string }
  | { type: 'manual'; note?: string; installCommand?: string };
export interface StarterEntry { id: string; license: string; why: string; source: StarterSource }

const REPO = /^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REF = /^[\w.-]{1,60}$/;
const MAX_TREE = 6_000_000;
const SOURCE_FILE = '.hub-source.json';
const SKILL_BUDGET_MS = 60_000;
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : undefined);
const UNPINNED = 'не закреплён на коммите: нужен 40-значный sha в registry/starter.json (его должен проставить человек, hub его не угадывает и не берёт «последний»)';

/** Read and validate `registry/starter.json`. Throws on anything unexpected: a malformed list must not half-work. A github entry without a 40-hex `ref` loads as `unpinned`. */
export function loadStarter(file = join(REPO_ROOT, 'registry', 'starter.json')): StarterEntry[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { skills?: unknown };
  if (!Array.isArray(raw.skills) || !raw.skills.length || raw.skills.length > 40) throw new Error('starter.json: skills must be a short list');
  const seen = new Set<string>();
  return raw.skills.map((s: Record<string, unknown>): StarterEntry => {
    const id = text(s['id'], 64);
    if (!id || !isSafeName(id)) throw new Error(`starter.json: bad id ${JSON.stringify(s['id'])}`);
    if (seen.has(id)) throw new Error(`starter.json: duplicate id ${id}`);
    seen.add(id);
    const license = text(s['license'], 60), why = text(s['why'], 300);
    if (!license) throw new Error(`starter.json: ${id}: license required (write "unknown" if it is not known)`);
    if (!why) throw new Error(`starter.json: ${id}: why required`);
    const src = (s['source'] ?? {}) as Record<string, unknown>;
    if (src['type'] === 'manual') return { id, license, why, source: { type: 'manual', ...(text(src['note'], 300) ? { note: text(src['note'], 300)! } : {}), ...(text(src['installCommand'], 200) ? { installCommand: text(src['installCommand'], 200)! } : {}) } };
    if (src['type'] !== 'github') throw new Error(`starter.json: ${id}: unknown source type`);
    const repo = String(src['repo'] ?? ''), path = String(src['path'] ?? '');
    if (!REPO.test(repo)) throw new Error(`starter.json: ${id}: bad repo`);
    if (!relOk(path)) throw new Error(`starter.json: ${id}: bad path`);
    const ref = src['ref'];
    if (ref !== undefined && ref !== null && (typeof ref !== 'string' || !REF.test(ref))) throw new Error(`starter.json: ${id}: bad ref`);
    if (typeof ref === 'string' && HEX40.test(ref)) return { id, license, why, source: { type: 'github', repo, path, ref } };
    return { id, license, why, source: { type: 'unpinned', repo, path, note: UNPINNED } };
  });
}

export const licenseKnown = (l: string): boolean => !/^(?:unknown|unlicensed|none|proprietary|noassertion)?$/i.test(l.trim());
const targetOf = (id: string): string => join(HUB_HOME, 'skills', id);
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
/** Something is there: a file, a link, or a folder that holds a file (empty folders left by an undo do not count). */
const occupied = (p: string): boolean => {
  try { const st = lstatSync(p); return !st.isDirectory() || readdirSync(p, { withFileTypes: true }).some((d) => !d.isDirectory() || occupied(join(p, d.name))); } catch { return false; }
};
const inLibrary = (id: string): boolean => occupied(targetOf(id)) || library().some((e) => e.id === `skill/${id}` && e.source.type === 'local');

export interface StarterItem {
  id: string; why: string; license: string; licenseKnown: boolean; target: string;
  /** available = the hub can fetch it; installed = a skill of this name is already on this PC; manual = installed by hand; unpinned = no commit pinned in the list yet. */
  state: 'available' | 'installed' | 'manual' | 'unpinned'; checked: boolean; note?: string; installCommand?: string;
}

/** What the first-run screen shows. No network. A skill is checked by default only when the hub can fetch it and its license (as the list states it) is known. */
export function starterItems(entries: StarterEntry[] = loadStarter()): StarterItem[] {
  return entries.map((e): StarterItem => {
    const known = licenseKnown(e.license);
    const state = inLibrary(e.id) ? 'installed' : e.source.type === 'manual' ? 'manual' : e.source.type === 'unpinned' ? 'unpinned' : 'available';
    return { id: e.id, why: e.why, license: e.license, licenseKnown: known, target: targetOf(e.id), state, checked: state === 'available' && known,
      ...(e.source.type !== 'github' && e.source.note ? { note: e.source.note } : {}), ...(e.source.type === 'manual' && e.source.installCommand ? { installCommand: e.source.installCommand } : {}) };
  });
}

/** Text fetcher that talks only to the repositories of `entries`: https, no port or credentials, the git tree at a sha and raw files at a sha. No branch is ever read. */
export function starterFetcher(entries: StarterEntry[] = loadStarter()): TextFetcher {
  const repos = new Set(entries.flatMap((e) => (e.source.type === 'github' ? [e.source.repo] : [])));
  return makeTextFetcher((u) => {
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (u.hostname === 'api.github.com') {
      const m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/[0-9a-f]{40}$/.exec(u.pathname);
      return !!m && repos.has(m[1]!) && (u.search === '' || u.search === '?recursive=1');
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+\/[^/]+)\/[0-9a-f]{40}\/[^?#]+$/.exec(u.pathname);
      return !!m && repos.has(m[1]!) && u.search === '';
    }
    return false;
  });
}

export interface FileInfo { path: string; size: number; /** why this file can run, when it can */ code?: string }
export interface SkillPreview {
  id: string; license: string; licenseKnown: boolean; repo: string; path: string; commit: string; target: string;
  files: FileInfo[]; text: string; runsCode: boolean;
  /** SKILL.md frontmatter keys an agent honours while the skill is active (hooks run commands, allowed-tools skips permission prompts), value verbatim */
  flags: { key: string; value: string }[];
  /** on by default in the confirm step: license known and no hooks/allowed-tools */
  defaultChecked: boolean; notes: string[];
  /** exact bytes to write: relative path → text */
  payload: Record<string, string>;
}
export interface StarterPreview { items: SkillPreview[]; skipped: { id: string; reason: string }[]; digest: string }

interface TreeNode { path?: unknown; mode?: unknown; type?: unknown; size?: unknown }

const HIDDEN: [string, RegExp][] = [
  ['zero-width character', /[​-‏⁠-⁤﻿]/u],
  ['tag character', /[\u{E0000}-\u{E007F}]/u],
  ['bidi control', /[‪-‮⁦-⁩]/u],
  ['control character', /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u],
];
/** The first invisible or control character of `t` (tab, newline and CR are fine), or null. */
function hiddenChar(t: string): string | null {
  for (const [name, re] of HIDDEN) { const m = re.exec(t); if (m) return `${name} U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`; }
  return null;
}

const CODE_EXT = /\.(?:cjs|mjs|js|ts|rb|pl|vbs|bat|cmd|ps1|psm1|sh|py)$/i;
function codeReason(rel: string, mode: string, t: string): string | undefined {
  const r: string[] = [];
  if (mode === '100755') r.push('исполняемый файл (git mode 100755)');
  if (t.startsWith('#!')) r.push('первая строка начинается с #!');
  if (CODE_EXT.test(rel)) r.push('расширение файла, который запускается');
  return r.length ? r.join('; ') : undefined;
}
function frontmatterFlags(md: string): { key: string; value: string }[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return [];
  const lines = m[1]!.split(/\r?\n/);
  const out: { key: string; value: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const k = /^(hooks|allowed-tools)\s*:(.*)$/i.exec(lines[i]!);
    if (!k) continue;
    let v = k[2]!.trim();
    for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]!) || !lines[j]!.trim()); j++) v += '\n' + lines[j];
    out.push({ key: k[1]!.toLowerCase(), value: v.trim().slice(0, 600) });
  }
  return out;
}

async function previewOne(e: StarterEntry & { source: { type: 'github' } }, rawFetch: TextFetcher, trees: Map<string, Promise<TreeNode[]>>, deadlineAt: number): Promise<SkillPreview> {
  const { repo, path, ref: commit } = e.source;
  if (isLink(join(HUB_HOME, 'skills'))) throw new Error('the hub library folder "skills" is a link: refusing to write through it');
  // one time budget per skill: every request gets what is left of it
  const fetchText: TextFetcher = (url, max) => {
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new Error('time limit for this skill exceeded');
    return rawFetch(url, max, AbortSignal.timeout(left)).catch((err: Error) => { throw Date.now() >= deadlineAt ? new Error('time limit for this skill exceeded') : err; });
  };
  const key = `${repo}@${commit}`;
  if (!trees.has(key)) trees.set(key, fetchText(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, MAX_TREE).then((t) => {
    const j = JSON.parse(t) as { truncated?: unknown; tree?: unknown };
    if (j.truncated === true) throw new Error('the repository tree is truncated (too large to read safely)');
    if (!Array.isArray(j.tree)) throw new Error('unexpected tree answer');
    return j.tree as TreeNode[];
  }));
  const prefix = `${path}/`;
  const mine = (await trees.get(key)!).filter((n) => typeof n.path === 'string' && n.path.startsWith(prefix));
  const rels: { rel: string; size: number; mode: string }[] = [];
  let announced = 0;
  for (const n of mine) {
    const rel = String(n.path).slice(prefix.length);
    if (n.type === 'commit' || n.mode === '160000') throw new Error(`submodule inside the skill: ${rel}`);
    if (n.mode === '120000') throw new Error(`symlink inside the skill: ${rel}`);
    if (n.type === 'tree') continue;
    if (n.type !== 'blob' || (n.mode !== '100644' && n.mode !== '100755')) throw new Error(`unexpected entry in the skill: ${rel}`);
    if (!relOk(rel)) throw new Error(`unsafe file path in the repository: ${rel}`);
    const size = Number(n.size);
    if (!Number.isFinite(size) || size > MAX_FILE) throw new Error(`file ${rel} is too large`);
    announced += size;
    rels.push({ rel, size, mode: String(n.mode) });
  }
  if (!rels.some((r) => r.rel === 'SKILL.md')) throw new Error('no SKILL.md at that path');
  // names a Windows or macOS disk cannot hold faithfully (NUL, CON, `:`, trailing dot, two names equal but for case): the same rule the review copy uses
  const bad = pathProblem([...rels.map((r) => r.rel), SOURCE_FILE], 'win32');
  if (bad) throw new Error(`unsafe file path in the repository (${bad.split(';')[0]})`);
  if (rels.length + 1 > MAX_FILES) throw new Error(`too many files (${rels.length} > ${MAX_FILES - 1})`);
  if (announced > MAX_TOTAL) throw new Error('the skill is too large');

  const payload: Record<string, string> = {};
  const files: FileInfo[] = [];
  let total = 0;
  for (const { rel, mode } of rels) {
    const t = await fetchText(`https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}/${rel.split('/').map(encodeURIComponent).join('/')}`);
    total += t.length;
    if (t.includes('\u0000')) throw new Error(`file ${rel} is binary (contains NUL)`);
    const hidden = hiddenChar(t);
    if (hidden) throw new Error(`file ${rel} contains an invisible or control character: ${hidden}; refused, because the reader cannot see it`);
    if (total > MAX_TOTAL) throw new Error('the skill is too large (over 1 MB in total)');
    payload[rel] = t;
    const code = codeReason(rel, mode, t);
    files.push({ path: rel, size: t.length, ...(code ? { code } : {}) });
  }
  const fm = parseFrontmatter(payload['SKILL.md']!);
  if (fm['name'] !== e.id) throw new Error(`skill name in SKILL.md (${fm['name'] ?? 'none'}) differs from the starter name ${e.id}`);
  const notes: string[] = [];
  const declared = fm['license'];
  if (declared && licenseKnown(e.license) && !declared.toLowerCase().includes(e.license.toLowerCase()) && !/licen[sc]e\.?(txt|md)?/i.test(declared)) notes.push(`SKILL.md names license "${declared.slice(0, 60)}", the starter list says ${e.license}: read the license file`);
  const flags = frontmatterFlags(payload['SKILL.md']!);
  payload[SOURCE_FILE] = JSON.stringify({ id: e.id, repo, path, commit, license: e.license }, null, 2) + '\n';
  files.push({ path: SOURCE_FILE, size: payload[SOURCE_FILE].length });
  const runsCode = files.some((f) => f.code) || /scripts\//.test(payload['SKILL.md']!);
  const known = licenseKnown(e.license);
  return { id: e.id, license: e.license, licenseKnown: known, repo, path, commit, target: targetOf(e.id), files, text: payload['SKILL.md']!, runsCode, flags, defaultChecked: known && !flags.length, notes, payload };
}

/** Everything that would be written for `ids`, without writing. A skill that cannot be installed is skipped with the reason, never half-installed. */
export async function previewStarter(ids: string[], fetchText?: TextFetcher, entries: StarterEntry[] = loadStarter(), o: { deadlineMs?: number } = {}): Promise<StarterPreview> {
  if (!ids.length) throw new Error('nothing selected');
  const by = new Map(entries.map((e) => [e.id, e]));
  const picked = [...new Set(ids)].map((id) => { const e = by.get(id); if (!e) throw new Error(`${id} is not in the starter set`); return e; });
  const fetcher = fetchText ?? starterFetcher(entries);
  const trees = new Map<string, Promise<TreeNode[]>>();
  const items: SkillPreview[] = [], skipped: { id: string; reason: string }[] = [];
  for (const e of picked) {
    if (e.source.type === 'manual') { skipped.push({ id: e.id, reason: `ставится вручную${e.source.installCommand ? `: ${e.source.installCommand}` : ''}${e.source.note ? ` (${e.source.note})` : ''}` }); continue; }
    if (e.source.type === 'unpinned') { skipped.push({ id: e.id, reason: e.source.note }); continue; }
    if (inLibrary(e.id)) { skipped.push({ id: e.id, reason: 'уже есть на этом компьютере: не перезаписываю' }); continue; }
    try { items.push(await previewOne(e as StarterEntry & { source: { type: 'github' } }, fetcher, trees, Date.now() + (o.deadlineMs ?? SKILL_BUDGET_MS))); }
    catch (err) { skipped.push({ id: e.id, reason: (err as Error).message }); }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash('sha256').update(JSON.stringify(items.map((i) => [i.id, i.commit, i.license, i.payload, i.files.map((f) => [f.path, f.code ?? null])]))).digest('hex');
  return { items, skipped, digest };
}

/** Dry-run plan inside the hub home: one folder per skill under `HUB_HOME/skills`, every file in full. Approval and backup go through `applyPlan`. */
export function planStarter(p: StarterPreview): Plan {
  if (!p.items.length) throw new Error('nothing to install');
  const changes = p.items.flatMap((i) => Object.entries(i.payload).map(([rel, t]) => {
    const code = i.files.find((f) => f.path === rel)?.code;
    const note = [rel === 'SKILL.md' ? `starter skill ${i.id} (${i.license}, ${i.repo}@${i.commit.slice(0, 7)})` : '', code ? `код: ${code}` : ''].filter(Boolean).join(' · ');
    return change(join(i.target, ...rel.split('/')), t, note || undefined);
  }));
  const notes = p.items.flatMap((i) => [
    `${i.id}: ${i.repo}/${i.path} на коммите ${i.commit.slice(0, 7)}, лицензия ${i.license} (по данным списка, hub её не проверял)`,
    ...(i.licenseKnown ? [] : [`${i.id}: лицензия не указана: прочитайте файлы прежде чем подключать к проекту`]),
    ...(i.runsCode ? [`${i.id}: contains scripts or starts a program: read them before linking it to a project`] : []),
    ...i.files.filter((f) => f.code).map((f) => `${i.id}: ${f.path}: ${f.code}`),
    ...i.flags.map((f) => `${i.id}: SKILL.md задаёт ${f.key}: ${f.value} (${f.key === 'hooks' ? 'это команды, которые запустятся, пока скилл активен' : 'инструменты без запроса разрешения, пока скилл активен'}); по умолчанию не отмечен`),
    ...i.notes.map((n) => `${i.id}: ${n}`),
  ]);
  return effective({ root: HUB_HOME, changes, notes });
}

const BACKUP_ID = /^[\w.-]+$/;
const markerOf = (backupId: string): string => join(HUB_HOME, '.hub', 'backups', backupId, 'starter.json');

/** Write the skills of `p` that are in `o.install` (default: those checked by default) through `applyPlan`, and mark the backup as a starter install so `undoStarter` accepts it. */
export function applyStarter(p: StarterPreview, o: { install?: string[] } = {}): ApplyResult & { installed: string[] } {
  const want = new Set(o.install ?? p.items.filter((i) => i.defaultChecked).map((i) => i.id));
  const items = p.items.filter((i) => want.has(i.id));
  if (!items.length) throw new Error('nothing selected');
  const r = applyPlan(planStarter({ ...p, items }), { approved: true });
  writeFileSync(markerOf(r.backupId), JSON.stringify({ ids: items.map((i) => i.id) }));
  return { ...r, installed: items.map((i) => i.id) };
}

function removeEmptyDirs(dir: string): void {
  if (isLink(dir)) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of entries) if (d.isDirectory()) removeEmptyDirs(join(dir, d.name));
  try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* not empty or gone */ }
}

/** Undo one starter install: only a backup that `applyStarter` made, once. Files go back to their earlier state and the skill folders are removed when they are empty. */
export function undoStarter(backupId: string): { restored: number; removed: number; ids: string[] } {
  if (typeof backupId !== 'string' || !BACKUP_ID.test(backupId) || backupId.includes('..')) throw new Error('invalid backup id');
  const marker = markerOf(backupId);
  if (!existsSync(marker)) throw new Error('not a starter install (or already undone)');
  const ids = ((JSON.parse(readFileSync(marker, 'utf8')) as { ids?: unknown }).ids as unknown[]).filter((x): x is string => typeof x === 'string' && isSafeName(x));
  const r = undoBackup(HUB_HOME, backupId);
  unlinkSync(marker);
  for (const id of ids) removeEmptyDirs(targetOf(id));
  return { ...r, ids };
}
