import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hashPath } from '../lib/hash.ts';
import { isSafeName } from '../lib/paths.ts';
import { detectAgents } from '../adapters/locate.ts';
import { compileAll } from './compilers.ts';
import { change, effective } from './plan.ts';
import { REPO_ROOT, library } from './registry.ts';
import type { FileChange, HubConfig, Lock, LockEntry, Plan, RegistryEntry } from './types.ts';

export interface Pack { id: string; title: string; mandatory: string[]; tags: string[] }

export const loadPack = (type: string): Pack => {
  const p = join(REPO_ROOT, 'packs', `${type}.json`);
  if (!existsSync(p)) throw new Error(`unknown project type "${type}"`);
  return JSON.parse(readFileSync(p, 'utf8')) as Pack;
};
export const listPacks = (): Pack[] => ['web-saas', 'mobile-app', 'automation', 'design-study'].map(loadPack);

export function buildLock(selected: RegistryEntry[], now = new Date()): Lock {
  const entries: LockEntry[] = selected.map((e) => {
    const src = e.source.type === 'local' ? e.source.path : undefined;
    return {
      id: e.id, kind: e.kind, source: e.source, hash: src && existsSync(src) ? hashPath(src) : null, license: e.license ?? null, tokenCost: e.tokenCost,
      targets: {
        claude: { status: e.compat.claude, ...(e.kind === 'skill' ? { installedTo: `.claude/skills/${e.id.split('/')[1]}` } : {}) },
        codex: { status: e.compat.codex, ...(e.kind === 'skill' ? { installedTo: `.agents/skills/${e.id.split('/')[1]}` } : {}) },
      },
      approvedAt: now.toISOString(),
    };
  });
  return { version: 1, generatedAt: now.toISOString(), entries };
}

/**
 * Build the write plan for `hub init`. Pure: reads the project and the library, writes nothing.
 * `extra` = ids chosen on top of the project type's mandatory set; tools chosen earlier (toolkit.json) are kept.
 * `remove` = skill ids to take out of this project: only the project's links are removed, never the skill itself.
 */
export function planInit(root: string, opts: { type: string; extra?: string[]; remove?: string[]; withCodex?: boolean }): Plan & { missing: string[]; selected: RegistryEntry[] } {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${root}`);
  const pack = loadPack(opts.type);
  const lib = library(root);
  const byId = new Map(lib.map((e) => [e.id, e]));
  let before: string[] = [];
  try { before = (JSON.parse(readFileSync(join(root, 'toolkit.json'), 'utf8')) as { selected: { id: string }[] }).selected.map((x) => x.id); } catch { /* first init */ }
  const drop = new Set((opts.remove ?? []).filter((id) => id.startsWith('skill/') && isSafeName(id.slice('skill/'.length)) && !pack.mandatory.includes(id)));
  const wanted = [...new Set([...pack.mandatory, ...before, ...(opts.extra ?? [])])].filter((id) => !drop.has(id));
  const selected = wanted.map((id) => byId.get(id)).filter((e): e is RegistryEntry => !!e);
  const missing = wanted.filter((id) => !byId.has(id));
  const agents = detectAgents();

  const cfg: HubConfig = {
    version: 1, project: { slug: basename(root), type: opts.type },
    agents: [{ id: 'claude', enabled: agents.claude.installed }, { id: 'codex', enabled: agents.codex.installed }],
    rules: { source: 'AGENTS.md', claudePointer: true }, limits: { handoffThresholdPercent: 95, autoHandoff: false },
  };
  const hubPath = join(root, 'hub.json');
  const keepCfg = existsSync(hubPath);
  const changes: FileChange[] = [];
  if (!keepCfg) changes.push(change(hubPath, JSON.stringify(cfg, null, 2) + '\n', 'project config'));
  changes.push(change(join(root, 'toolkit.json'), JSON.stringify({ stage: 3, selected: selected.map((e) => ({ id: e.id, mandatory: pack.mandatory.includes(e.id) })), missing }, null, 2) + '\n', 'chosen tools'));
  changes.push(...compileAll(root, selected, opts.type));
  for (const id of drop) for (const d of ['.claude', '.agents']) { const p = join(root, d, 'skills', id.slice('skill/'.length)); try { if (lstatSync(p).isSymbolicLink()) changes.push({ path: p, action: 'unlink', before: null, after: '', note: 'tool removed from this project' }); } catch { /* not linked */ } }
  changes.push(change(join(root, 'hub.lock.json'), JSON.stringify(buildLock(selected, new Date(0)), null, 2) + '\n', 'versions + hashes'));
  const plan = effective({ root, changes, notes: [!agents.claude.installed ? 'Claude Code не найден на этом компьютере' : '', !agents.codex.installed ? 'Codex не найден на этом компьютере' : '',
    ...missing.map((m) => `Скилл «${m.replace(/^\w+\//, '')}» не найден на компьютере и пропущен. Если он лежит в своей папке, добавьте её в Настройках («Свои папки со скиллами»).`),
    ...selected.filter((e) => e.kind === 'skill' && e.source.type !== 'local').map((e) => `Скилл «${e.title}» не установлен${e.installCommand ? `. Установка: ${e.installCommand}` : ''}`)].filter(Boolean) });
  return { ...plan, missing, selected };
}
