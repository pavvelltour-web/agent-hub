import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { isSecretPath, norm } from '../lib/paths.ts';
import type { AgentId, RegistryEntry } from './types.ts';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HUB_HOME = process.env['AGENT_HUB_HOME'] ?? join(homedir(), '.agent-hub');

export interface UserConfig { extraSkillRoots?: string[]; projects?: string[]; routing?: { priceWeight?: number; explore?: number }; sharing?: { consent: boolean; at: string; version: number }; /** ADR-026: the user's own caps for the circuit breaker (read by src/run/breaker.ts, which validates every field); only POST /api/guardrails writes it */ guardrails?: Record<string, unknown> }
export const loadUserConfig = (): UserConfig => {
  try { return JSON.parse(readFileSync(join(HUB_HOME, 'config.json'), 'utf8')) as UserConfig; } catch { return {}; }
};

/** The hub's own config lives in HUB_HOME (never in a foreign agent store), so saving it needs no plan. */
export function saveUserConfig(c: UserConfig): void {
  mkdirSync(HUB_HOME, { recursive: true });
  writeFileSync(join(HUB_HOME, 'config.json'), JSON.stringify(c, null, 2) + '\n');
}

/** A skill root is an existing folder that is not (inside) a credential store. */
export function validateSkillRoot(p: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path required');
  const n = norm(resolve(p.trim()));
  if (isSecretPath(n)) throw new Error('this folder is not allowed');
  let st; try { st = statSync(n); } catch { throw new Error('folder not found'); }
  if (!st.isDirectory()) throw new Error('not a folder');
  return n;
}
export function addSkillRoot(p: string): UserConfig {
  const n = validateSkillRoot(p); const c = loadUserConfig();
  const list = [...new Set([...(c.extraSkillRoots ?? []), n])];
  const next = { ...c, extraSkillRoots: list }; saveUserConfig(next); return next;
}
export function removeSkillRoot(p: string): UserConfig {
  const key = norm(resolve(p.trim())).toLowerCase(); const c = loadUserConfig();
  const next = { ...c, extraSkillRoots: (c.extraSkillRoots ?? []).filter((x) => norm(resolve(x)).toLowerCase() !== key) }; saveUserConfig(next); return next;
}

export interface RootInfo { path: string; scope: 'user' | 'project' | 'hub'; visibleTo: AgentId[] }

/**
 * Skill roots scanned for local skills, with what each one means for the agents.
 * Order = priority when a name exists in several. Claude reads ~/.claude/skills; Codex reads ~/.agents/skills (and the older
 * ~/.codex/skills). Folders the user added and the hub's own library are NOT loaded by any agent until a project links a skill.
 */
export const skillRootInfos = (project?: string): RootInfo[] => ([
  ...(project ? [
    { path: join(project, '.agents', 'skills'), scope: 'project', visibleTo: ['codex'] },
    { path: join(project, '.claude', 'skills'), scope: 'project', visibleTo: ['claude'] },
  ] : []),
  { path: join(homedir(), '.agents', 'skills'), scope: 'user', visibleTo: ['codex'] },
  { path: join(homedir(), '.codex', 'skills'), scope: 'user', visibleTo: ['codex'] },
  { path: join(homedir(), '.claude', 'skills'), scope: 'user', visibleTo: ['claude'] },
  { path: join(HUB_HOME, 'skills'), scope: 'hub', visibleTo: [] },
  ...(loadUserConfig().extraSkillRoots ?? []).map((p) => ({ path: p, scope: 'hub', visibleTo: [] })),
] as RootInfo[]).filter((r) => existsSync(r.path));

export const skillRoots = (project?: string): string[] => skillRootInfos(project).map((r) => r.path);

/** Every directory holding a SKILL.md directly under `root`, plus `root/<plugin>/skills/*` (plugin layout). */
function* skillDirs(root: string): Generator<string> {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return; }
  for (const n of names) {
    const d = join(root, n);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    if (existsSync(join(d, 'SKILL.md'))) yield d;
    else if (n === 'skills' || existsSync(join(d, 'skills'))) yield* skillDirs(d);
  }
  if (existsSync(join(root, 'skills'))) yield* skillDirs(join(root, 'skills'));
}

/** Scan local skills into registry entries. Token cost ≈ chars/4 of name+description (what every turn pays). */
export function scanLocalSkills(project?: string): RegistryEntry[] {
  const seen = new Map<string, RegistryEntry>();
  const RANK = { project: 0, user: 1, hub: 2 } as const;
  for (const { path: root, scope, visibleTo } of skillRootInfos(project)) {
    for (const dir of skillDirs(root)) {
      let text = '';
      try { text = readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(text);
      const name = fm['name'] ?? dir.split(/[\\/]/).pop() ?? '';
      if (!name) continue;
      const prev = seen.get(name);
      if (prev) { prev.visibleTo = [...new Set([...(prev.visibleTo ?? []), ...visibleTo])]; if (scope === 'user') prev.globalVisibleTo = [...new Set([...(prev.globalVisibleTo ?? []), ...visibleTo])]; if (RANK[scope] < RANK[prev.scope ?? 'hub']) prev.scope = scope; continue; }
      const desc = fm['description'] ?? '';
      const runsCode = /(^|\n)(##? )?.*(scripts\/|\.py\b|\.sh\b)/.test(text.slice(0, 4000));
      seen.set(name, {
        id: `skill/${name}`, kind: 'skill', title: name, description: desc,
        source: { type: 'local', path: norm(dir) }, license: fm['license'] ?? 'unknown', tags: [], stages: [], projectTypes: ['*'],
        compat: { claude: 'native', codex: 'native' }, tokenCost: Math.ceil((name.length + Math.min(desc.length, 1536)) / 4),
        risk: { executesCode: runsCode, network: false, writesOutside: false }, sourceVerified: true, scope, visibleTo: [...visibleTo], globalVisibleTo: scope === 'user' ? [...visibleTo] : [],
      });
    }
  }
  return [...seen.values()];
}

const readCatalogDir = (dir: string): RegistryEntry[] => {
  const out: RegistryEntry[] = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RegistryEntry | RegistryEntry[];
    out.push(...(Array.isArray(j) ? j : [j]));
  }
  return out;
};

/** Ids of the shipped catalog (registry/entries/*.json): the only entries whose `sourceVerified` the hub itself vouches for. */
export const shippedCatalogIds = (): string[] => readCatalogDir(join(REPO_ROOT, 'registry', 'entries')).map((e) => e.id);

/**
 * Shipped catalog (registry/entries/*.json) plus the personal one (~/.agent-hub/registry/*.json). On an id collision the SHIPPED entry wins,
 * for the panel and for a run alike: a file in the hub home cannot redefine what a shipped server or skill starts.
 */
export function loadCatalog(): RegistryEntry[] {
  const shipped = readCatalogDir(join(REPO_ROOT, 'registry', 'entries')), ids = new Set(shipped.map((e) => e.id));
  return [...shipped, ...readCatalogDir(join(HUB_HOME, 'registry')).filter((e) => !ids.has(e.id))];
}

/** Local skills win over catalog entries with the same id (they have a real source path). */
export function library(project?: string): RegistryEntry[] {
  const byId = new Map<string, RegistryEntry>();
  for (const e of loadCatalog()) byId.set(e.id, e);
  for (const e of scanLocalSkills(project)) byId.set(e.id, { ...(byId.get(e.id) ?? {}), ...e, tags: byId.get(e.id)?.tags ?? e.tags, stages: byId.get(e.id)?.stages ?? e.stages });
  return [...byId.values()];
}
