import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { isSafeName } from '../lib/paths.ts';
import { MAX_FILE, MAX_FILES, MAX_TOTAL, makeTextFetcher, relOk, type TextFetcher } from './install-remote.ts';
import { pathProblem } from '../review/checks.ts';
import { change, effective } from './plan.ts';
import { HUB_HOME, REPO_ROOT, library } from './registry.ts';
import type { Plan } from './types.ts';

/**
 * Starter kit: a short list of skills the hub offers on first run, installed into the hub LIBRARY (`HUB_HOME/skills`), where they cost no tokens
 * until a project links them. `registry/starter.json` is data, not a command: the hub fetches only from the repositories named there, only at ONE
 * commit (a branch is resolved to its sha when the user asks for the preview, every file is read at that sha, and the user approves exactly those
 * bytes: the digest covers sha and content). Nothing is run, nothing is written outside the library, existing folders are never touched (ADR-022).
 */
export type StarterSource =
  | { type: 'github'; repo: string; path: string; ref: string }
  | { type: 'manual'; note?: string; installCommand?: string };
export interface StarterEntry { id: string; license: string; why: string; source: StarterSource }

const REPO = /^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REF = /^(?:[0-9a-f]{40}|[A-Za-z0-9][\w.-]{0,59})$/;
const MOVING = /^(?:latest|head)$/i;
const MAX_TREE = 6_000_000;
const SOURCE_FILE = '.hub-source.json';
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : undefined);

/** Read and validate `registry/starter.json`. Throws on anything unexpected: a malformed list must not half-work. */
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
    const repo = String(src['repo'] ?? ''), path = String(src['path'] ?? ''), ref = String(src['ref'] ?? '');
    if (!REPO.test(repo)) throw new Error(`starter.json: ${id}: bad repo`);
    if (!relOk(path)) throw new Error(`starter.json: ${id}: bad path`);
    if (!REF.test(ref) || MOVING.test(ref)) throw new Error(`starter.json: ${id}: bad ref (a commit sha or a branch name; not latest/HEAD)`);
    return { id, license, why, source: { type: 'github', repo, path, ref } };
  });
}

export const licenseKnown = (l: string): boolean => !/^(?:unknown|unlicensed|none|proprietary|noassertion)?$/i.test(l.trim());
const targetOf = (id: string): string => join(HUB_HOME, 'skills', id);
/** Something is there: a file, a link, or a folder that holds a file (empty folders left by an undo do not count). */
const occupied = (p: string): boolean => {
  try { const st = lstatSync(p); return !st.isDirectory() || readdirSync(p, { withFileTypes: true }).some((d) => !d.isDirectory() || occupied(join(p, d.name))); } catch { return false; }
};
const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const inLibrary = (id: string): boolean => occupied(targetOf(id)) || library().some((e) => e.id === `skill/${id}` && e.source.type === 'local');

export interface StarterItem {
  id: string; why: string; license: string; licenseKnown: boolean; target: string;
  /** available = the hub can fetch it; installed = a skill of this name is already on this PC; manual = the hub cannot fetch it. */
  state: 'available' | 'installed' | 'manual'; checked: boolean; note?: string; installCommand?: string;
}

/** What the first-run screen shows. No network. A skill is checked by default only when the hub can fetch it and its license is known. */
export function starterItems(entries: StarterEntry[] = loadStarter()): StarterItem[] {
  return entries.map((e): StarterItem => {
    const known = licenseKnown(e.license);
    const manual = e.source.type === 'manual';
    const state = inLibrary(e.id) ? 'installed' : manual ? 'manual' : 'available';
    return { id: e.id, why: e.why, license: e.license, licenseKnown: known, target: targetOf(e.id), state, checked: state === 'available' && known,
      ...(e.source.type === 'manual' && e.source.note ? { note: e.source.note } : {}), ...(e.source.type === 'manual' && e.source.installCommand ? { installCommand: e.source.installCommand } : {}) };
  });
}

/** Text fetcher that talks only to the repositories of `entries`: https, no port or credentials, API paths for a branch ref and a tree at a sha, raw files at a sha. */
export function starterFetcher(entries: StarterEntry[] = loadStarter()): TextFetcher {
  const repos = new Set(entries.flatMap((e) => (e.source.type === 'github' ? [e.source.repo] : [])));
  return makeTextFetcher((u) => {
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (u.hostname === 'api.github.com') {
      const m = /^\/repos\/([^/]+\/[^/]+)\/git\/(?:ref\/heads\/[\w.-]+|trees\/[0-9a-f]{40})$/.exec(u.pathname);
      return !!m && repos.has(m[1]!) && (u.search === '' || (u.search === '?recursive=1' && u.pathname.includes('/trees/')));
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+\/[^/]+)\/[0-9a-f]{40}\/[^?#]+$/.exec(u.pathname);
      return !!m && repos.has(m[1]!) && u.search === '';
    }
    return false;
  });
}

export interface SkillPreview {
  id: string; license: string; licenseKnown: boolean; repo: string; path: string; commit: string; target: string;
  files: { path: string; size: number }[]; text: string; runsCode: boolean; notes: string[];
  /** exact bytes to write: relative path → text */
  payload: Record<string, string>;
}
export interface StarterPreview { items: SkillPreview[]; skipped: { id: string; reason: string }[]; digest: string }

interface TreeNode { path?: unknown; mode?: unknown; type?: unknown; size?: unknown }
const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

async function previewOne(e: StarterEntry & { source: { type: 'github' } }, fetchText: TextFetcher, trees: Map<string, Promise<TreeNode[]>>): Promise<SkillPreview> {
  const { repo, path } = e.source;
  if (isLink(join(HUB_HOME, 'skills'))) throw new Error('the hub library folder "skills" is a link: refusing to write through it');
  let commit = e.source.ref;
  if (!HEX40.test(commit)) {
    const j = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/git/ref/heads/${commit}`, 50_000)) as { object?: { sha?: unknown } };
    commit = String(j.object?.sha ?? '');
    if (!HEX40.test(commit)) throw new Error('the branch did not resolve to a commit');
  }
  const key = `${repo}@${commit}`;
  if (!trees.has(key)) trees.set(key, fetchText(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, MAX_TREE).then((t) => {
    const j = JSON.parse(t) as { truncated?: unknown; tree?: unknown };
    if (j.truncated === true) throw new Error('the repository tree is truncated (too large to read safely)');
    if (!Array.isArray(j.tree)) throw new Error('unexpected tree answer');
    return j.tree as TreeNode[];
  }));
  const prefix = `${path}/`;
  const mine = (await trees.get(key)!).filter((n) => typeof n.path === 'string' && n.path.startsWith(prefix));
  const rels: { rel: string; size: number }[] = [];
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
    rels.push({ rel, size });
  }
  if (!rels.some((r) => r.rel === 'SKILL.md')) throw new Error('no SKILL.md at that path');
  // names a Windows or macOS disk cannot hold faithfully (NUL, CON, `:`, trailing dot, two names equal but for case): the same rule the review copy uses
  const bad = pathProblem([...rels.map((r) => r.rel), SOURCE_FILE], 'win32');
  if (bad) throw new Error(`unsafe file path in the repository (${bad.split(';')[0]})`);
  if (rels.length + 1 > MAX_FILES) throw new Error(`too many files (${rels.length} > ${MAX_FILES - 1})`);
  if (announced > MAX_TOTAL) throw new Error('the skill is too large');

  const payload: Record<string, string> = {};
  let total = 0;
  for (const { rel } of rels) {
    const t = await fetchText(`https://raw.githubusercontent.com/${repo}/${commit}/${enc(path)}/${enc(rel)}`);
    total += t.length;
    if (t.includes('\u0000')) throw new Error(`file ${rel} is binary`);
    if (total > MAX_TOTAL) throw new Error('the skill is too large');
    payload[rel] = t;
  }
  const fm = parseFrontmatter(payload['SKILL.md']!);
  if (fm['name'] !== e.id) throw new Error(`skill name in SKILL.md (${fm['name'] ?? 'none'}) differs from the starter name ${e.id}`);
  const notes: string[] = [];
  const declared = fm['license'];
  if (declared && licenseKnown(e.license) && !declared.toLowerCase().includes(e.license.toLowerCase()) && !/licen[sc]e\.?(txt|md)?/i.test(declared)) notes.push(`SKILL.md names license "${declared.slice(0, 60)}", the starter list says ${e.license}: read the license file`);
  payload[SOURCE_FILE] = JSON.stringify({ id: e.id, repo, path, commit, license: e.license }, null, 2) + '\n';
  const runsCode = Object.keys(payload).some((f) => /\.(py|sh|js|mjs|ts|ps1|bat|cmd)$/i.test(f)) || /scripts\//.test(payload['SKILL.md']!);
  return { id: e.id, license: e.license, licenseKnown: licenseKnown(e.license), repo, path, commit, target: targetOf(e.id), files: Object.entries(payload).map(([p, t]) => ({ path: p, size: t.length })), text: payload['SKILL.md']!, runsCode, notes, payload };
}

/** Everything that would be written for `ids`, without writing. A skill that cannot be installed is skipped with the reason, never half-installed. */
export async function previewStarter(ids: string[], fetchText?: TextFetcher, entries: StarterEntry[] = loadStarter()): Promise<StarterPreview> {
  if (!ids.length) throw new Error('nothing selected');
  const by = new Map(entries.map((e) => [e.id, e]));
  const picked = [...new Set(ids)].map((id) => { const e = by.get(id); if (!e) throw new Error(`${id} is not in the starter set`); return e; });
  const fetcher = fetchText ?? starterFetcher(entries);
  const trees = new Map<string, Promise<TreeNode[]>>();
  const items: SkillPreview[] = [], skipped: { id: string; reason: string }[] = [];
  for (const e of picked) {
    if (e.source.type === 'manual') { skipped.push({ id: e.id, reason: `ставится вручную${e.source.installCommand ? `: ${e.source.installCommand}` : ''}${e.source.note ? ` (${e.source.note})` : ''}` }); continue; }
    if (inLibrary(e.id)) { skipped.push({ id: e.id, reason: 'уже есть на этом компьютере: не перезаписываю' }); continue; }
    try { items.push(await previewOne(e as StarterEntry & { source: { type: 'github' } }, fetcher, trees)); }
    catch (err) { skipped.push({ id: e.id, reason: (err as Error).message }); }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash('sha256').update(JSON.stringify(items.map((i) => [i.id, i.commit, i.license, i.payload]))).digest('hex');
  return { items, skipped, digest };
}

/** Dry-run plan inside the hub home: one folder per skill under `HUB_HOME/skills`. Approval and backup go through `applyPlan`. */
export function planStarter(p: StarterPreview): Plan {
  if (!p.items.length) throw new Error('nothing to install');
  const changes = p.items.flatMap((i) => Object.entries(i.payload).map(([rel, t]) => change(join(i.target, ...rel.split('/')), t, rel === 'SKILL.md' ? `starter skill ${i.id} (${i.license}, ${i.repo}@${i.commit.slice(0, 7)})` : undefined)));
  const notes = p.items.flatMap((i) => [
    `${i.id}: ${i.repo}/${i.path} at commit ${i.commit.slice(0, 7)}, license ${i.license}`,
    ...(i.licenseKnown ? [] : [`${i.id}: лицензия не указана: прочитайте файлы прежде чем подключать к проекту`]),
    ...(i.runsCode ? [`${i.id}: contains scripts or starts a program: read them before linking it to a project`] : []),
    ...i.notes.map((n) => `${i.id}: ${n}`),
  ]);
  return effective({ root: HUB_HOME, changes, notes });
}
