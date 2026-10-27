import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { isSecretPath, pathKey } from '../lib/paths.ts';
import { git, minimalEnv } from '../run/git.ts';
import { validArgv } from '../run/cascade.ts';
import { applyPlan, change, type ApplyResult } from './plan.ts';
import { planInit } from './init.ts';
import { HUB_HOME, REPO_ROOT } from './registry.ts';
import type { FileChange, Plan } from './types.ts';

/**
 * `hub new <type> <folder>`: a project skeleton from `templates/<type>/` (brief, architecture, .gitignore, `hub.json` with a `verify` command), the
 * rules (`AGENTS.md` from `renderRules`, with the type's section), the type's skills and `git init`, as ONE plan the user approves.
 * The template's `verify` is data from a file: it is written into the new project's `hub.json` like any other project's and is NOT approved here;
 * it runs only after the digest-pinned approval of the review/cascade flow (ADR-017). The folder must be new or empty.
 */
export const TEMPLATE_TYPES = ['web-saas', 'mobile-app', 'automation', 'design-study'] as const;

export interface PlannedStep { argv: string[]; cwd: string; note: string }
export interface NewProjectPlan extends Plan { type: string; verify: string[]; steps: PlannedStep[] }

const SKIP = new Set(['REVIEW.md', 'hub.json']);   // REVIEW.md comes from the review compiler; hub.json is merged into the generated config
const MAX_TEMPLATE_FILE = 100_000;
const GIT_INIT = ['git', 'init', '-b', 'main'];

const inside = (p: string, base: string): boolean => { const k = pathKey(p), b = pathKey(base); return k === b || k.startsWith(b.endsWith('/') ? b : b + '/'); };

/** Where a new project may not be created: a drive root, a credential folder, an agent's own store, the hub's data. */
function checkFolder(root: string): void {
  if (parse(root).root === root) throw new Error('a drive or filesystem root is not a project folder');
  if (isSecretPath(root)) throw new Error('this folder is not allowed');
  const stores = [join(homedir(), '.claude'), join(homedir(), '.codex'), join(homedir(), '.agents'), ...(process.env['APPDATA'] ? [join(process.env['APPDATA'], 'Claude')] : []), HUB_HOME];
  if (stores.some((s) => inside(root, s))) throw new Error('this folder belongs to an agent or to the hub itself: choose another');
  let st; try { st = lstatSync(root); } catch { return; }          // does not exist yet: fine
  if (st.isSymbolicLink()) throw new Error('the folder is a link: choose the real folder');
  if (!st.isDirectory()) throw new Error('not a folder');
  if (readdirSync(root).length) throw new Error('the folder is not empty: choose a new or empty folder (hub new never mixes into existing work)');
}

const templateFiles = (dir: string, sub = ''): string[] => readdirSync(join(dir, sub), { withFileTypes: true }).flatMap((d) => {
  const rel = sub ? `${sub}/${d.name}` : d.name;
  if (d.isDirectory()) return templateFiles(dir, rel);
  return d.isFile() && !SKIP.has(rel) ? [rel] : [];
});

export function planNewProject(type: string, folder: string): NewProjectPlan {
  if (!(TEMPLATE_TYPES as readonly string[]).includes(type)) throw new Error(`unknown project type "${String(type).slice(0, 40)}"`);
  if (typeof folder !== 'string' || !folder.trim() || folder.includes('\0')) throw new Error('folder required');
  const root = resolve(folder.trim());
  checkFolder(root);
  const name = basename(root);
  const tdir = join(REPO_ROOT, 'templates', type);
  if (!existsSync(join(tdir, 'hub.json'))) throw new Error(`template for ${type} is missing`);
  const overlay = JSON.parse(readFileSync(join(tdir, 'hub.json'), 'utf8')) as { verify?: unknown };
  if (!validArgv(overlay.verify)) throw new Error(`template for ${type}: verify is not a valid command list`);
  const verify = [...overlay.verify];

  const base = planInit(root, { type, graphify: null, allowMissing: true });
  const changes: FileChange[] = base.changes.map((c) => {
    if (c.path !== join(root, 'hub.json')) return c;
    const cfg = JSON.parse(c.after) as Record<string, unknown>;
    return { ...c, after: JSON.stringify({ ...cfg, verify }, null, 2) + '\n', note: 'project config + verify command (not approved yet)' };
  });
  const taken = new Set(changes.map((c) => pathKey(c.path)));
  for (const rel of templateFiles(tdir)) {
    const path = join(root, ...(rel === 'gitignore' ? '.gitignore' : rel).split('/'));   // npm never packs a file named .gitignore, so the template carries it as `gitignore`
    if (taken.has(pathKey(path))) continue;
    const src = join(tdir, ...rel.split('/'));
    if (lstatSync(src).size > MAX_TEMPLATE_FILE) throw new Error(`template file too large: ${rel}`);
    changes.push(change(path, readFileSync(src, 'utf8').replaceAll('{{name}}', name), `template ${type}`));
  }
  const steps: PlannedStep[] = [{ argv: [...GIT_INIT], cwd: root, note: 'создать репозиторий git (ветка main)' }];
  const notes = [...base.notes,
    `Команда проверки (verify) из шаблона: ${verify[0]} …. Она записана в hub.json, но не одобрена: hub не запустит её, пока вы не одобрите её целиком (покажет ревью или каскад).`,
    `После записи выполнится одна команда: ${GIT_INIT.join(' ')} в ${root}. Больше ничего не запускается.`];
  return { root, changes, notes, type, verify, steps };
}

export interface NewProjectResult extends ApplyResult { steps: { argv: string[]; ok: boolean; message: string }[] }

/** Write an APPROVED plan and run its planned steps. The folder is checked again (it may have filled up since the plan) and only the one known step is accepted. */
export function applyNewProject(plan: NewProjectPlan, opts: { approved: boolean }): NewProjectResult {
  if (!opts.approved) throw new Error('plan not approved');
  const root = resolve(plan.root);
  for (const s of plan.steps) if (JSON.stringify(s.argv) !== JSON.stringify(GIT_INIT) || resolve(s.cwd) !== root) throw new Error('step not allowed');
  checkFolder(root);
  const written = applyPlan(plan, { approved: true });
  const steps = plan.steps.map((s) => {
    const r = git(root, s.argv.slice(1), minimalEnv());
    return { argv: s.argv, ok: r.ok, message: (r.ok ? r.out : r.err).slice(0, 300) };
  });
  return { ...written, steps };
}
