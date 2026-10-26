import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { change, readText } from './plan.ts';
import { listPlugins } from './profile.ts';
import { library } from './registry.ts';
import type { AgentId, FileChange, RegistryEntry } from './types.ts';

/**
 * What each agent loads into EVERY turn of a project, and how to trim it for that project only.
 *
 * Claude Code (per its docs, not run live here): `skillOverrides` in a settings file hides personal/project skills by name
 * ("name-only" keeps just the name, "off" hides them); it does not apply to plugin skills, which are switched by `enabledPlugins`.
 * Codex: `[[skills.config]] path=… enabled=false` and `[plugins."id"] enabled=false` in config.toml. That a PROJECT-level
 * `.codex/config.toml` is honored for these keys is NOT verified.
 */
export type SkillState = 'on' | 'name-only' | 'off';
export interface Desired { skills?: Record<string, SkillState>; plugins?: Record<string, boolean> }

const CLAUDE_FILE = ['.claude', 'settings.local.json'];   // personal choice about personal installs: not committed
const BLOCK = /# >>> agent-hub:plugin-profile\n([\s\S]*?)# <<< agent-hub:plugin-profile\n/;
const nameTokens = (name: string): number => Math.ceil(name.length / 4) + 2;
/** Codex: the initial skill list is capped (2% of the context window, 8,000 characters when unknown ≈ 2,000 tokens). Assumption, see docs. */
export const CODEX_LIST_CAP_TOKENS = 2000;

interface ClaudeLocal { skillOverrides?: Record<string, string>; enabledPlugins?: Record<string, boolean> }
function readClaudeLocal(root: string): ClaudeLocal {
  const out: ClaudeLocal = {};
  for (const f of [['.claude', 'settings.json'], CLAUDE_FILE]) {
    try { const j = JSON.parse(readText(join(root, ...f)) ?? '{}') as ClaudeLocal; Object.assign(out, { skillOverrides: { ...out.skillOverrides, ...j.skillOverrides }, enabledPlugins: { ...out.enabledPlugins, ...j.enabledPlugins } }); } catch { /* invalid file: ignore here, compile refuses to overwrite it */ }
  }
  return out;
}
interface CodexBlock { skills: string[]; plugins: string[] }
function readCodexBlock(root: string): CodexBlock {
  const m = BLOCK.exec(readText(join(root, '.codex', 'config.toml')) ?? '');
  const body = m?.[1] ?? '';
  return {
    skills: [...body.matchAll(/\[\[skills\.config\]\]\npath = ("(?:[^"\\]|\\.)*")\nenabled = false/g)].map((x) => (JSON.parse(x[1] as string) as string).replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ':')),
    plugins: [...body.matchAll(/\[plugins\."([^"]+)"\]\nenabled = false/g)].map((x) => x[1] as string),
  };
}

export interface ToolRow { id: string; name: string; kind: 'skill' | 'plugin' | 'mcp'; agent: AgentId; origin: 'user' | 'project' | 'plugin' | 'config'; state: SkillState; baseTokens: number; tokens: number | null; detail: string; switchable: boolean; suggest?: boolean }
export interface LoadingAudit { rows: ToolRow[]; totals: Record<AgentId, { baseline: number; now: number; cap?: number }>; notes: string[] }

/** Read-only picture of what loads in this project, with the project's current overrides applied. */
/** Absolute SKILL.md path as Codex would print it: forward slashes, upper-case drive letter. */
export const skillMdPath = (dir: string): string => join(dir, 'SKILL.md').replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ':');

export const skillInfoFrom =(lib: RegistryEntry[]) => (name: string): SkillInfo | undefined => {
  const e = lib.find((x) => x.id === `skill/${name}`);
  return e ? { ...(e.source.path ? { path: skillMdPath(e.source.path) } : {}), agents: e.globalVisibleTo ?? [] } : undefined;
};

export function auditLoading(root: string, lib: RegistryEntry[] = library(root)): LoadingAudit {
  const claude = readClaudeLocal(root), codex = readCodexBlock(root);
  const type = (() => { try { return (JSON.parse(readText(join(root, 'hub.json')) ?? '{}') as { project?: { type?: string } }).project?.type; } catch { return undefined; } })();
  const rows: ToolRow[] = [];
  for (const e of lib.filter((x) => x.kind === 'skill')) {
    const name = e.id.slice('skill/'.length);
    for (const agent of ['claude', 'codex'] as AgentId[]) {
      if (!e.visibleTo?.includes(agent)) continue;
      const global = !!e.globalVisibleTo?.includes(agent);
      const path = e.source.path ? skillMdPath(e.source.path) : '';
      const st: SkillState = agent === 'claude' ? ((claude.skillOverrides?.[name] as SkillState | undefined) ?? 'on') : codex.skills.includes(path) ? 'off' : 'on';
      rows.push({ id: e.id, name, kind: 'skill', agent, origin: global ? 'user' : 'project', state: st, baseTokens: e.tokenCost, tokens: st === 'on' ? e.tokenCost : st === 'name-only' ? nameTokens(name) : 0, detail: e.description, switchable: global });
    }
  }
  const pl = listPlugins(type);
  for (const agent of ['claude', 'codex'] as AgentId[]) for (const p of pl[agent].filter((x) => x.enabled)) {
    const off = agent === 'claude' ? claude.enabledPlugins?.[p.id] === false : codex.plugins.includes(p.id);
    rows.push({ id: p.id, name: p.name, kind: 'plugin', agent, origin: 'plugin', state: off ? 'off' : 'on', baseTokens: p.tokens, tokens: off ? 0 : p.tokens, detail: `${p.skills} skills`, switchable: true, suggest: p.suggestDisable });
  }
  for (const [agent, names, where] of [['claude', mcpNamesClaude(root), '.mcp.json'], ['codex', mcpNamesCodex(root), 'config.toml']] as [AgentId, string[], string][])
    for (const n of names) rows.push({ id: `mcp/${n}`, name: n, kind: 'mcp', agent, origin: 'config', state: 'on', baseTokens: 0, tokens: null, detail: where, switchable: false });
  const totals = {} as LoadingAudit['totals'];
  for (const agent of ['claude', 'codex'] as AgentId[]) {
    const mine = rows.filter((r) => r.agent === agent && r.kind !== 'mcp');
    const baseline = mine.reduce((a, r) => a + r.baseTokens, 0), now = mine.reduce((a, r) => a + (r.tokens ?? 0), 0);
    totals[agent] = agent === 'codex' ? { baseline: Math.min(baseline, CODEX_LIST_CAP_TOKENS), now: Math.min(now, CODEX_LIST_CAP_TOKENS), cap: CODEX_LIST_CAP_TOKENS } : { baseline, now };
  }
  return { rows, totals, notes: [
    'Claude: user-level MCP servers (in ~/.claude.json) are not listed here; toggle them per project inside Claude with /mcp.',
    'MCP tool descriptions are loaded on demand by Claude (tool search), so their per-turn cost is shown as unknown rather than guessed.',
  ] };
}

function mcpNamesClaude(root: string): string[] {
  try { return Object.keys((JSON.parse(readText(join(root, '.mcp.json')) ?? '{}') as { mcpServers?: object }).mcpServers ?? {}); } catch { return []; }
}
function mcpNamesCodex(root: string): string[] {
  const names = new Set<string>();
  for (const f of [join(root, '.codex', 'config.toml'), join(homedir(), '.codex', 'config.toml')]) {
    if (!existsSync(f)) continue;
    // Table headers only: never read values (they can hold tokens).
    for (const m of readFileSync(f, 'utf8').matchAll(/^\[mcp_servers\.("?)([\w.-]+)\1\]\s*$/gm)) names.add(m[2] as string);
  }
  return [...names];
}

const tomlStr = (s: string): string => JSON.stringify(s);

/**
 * Write the project's tool profile. `desired` holds only what the user changed: 'on' / true removes our override
 * (the project inherits the global setting again). Other keys in the files are kept; invalid JSON is never overwritten.
 */
export interface SkillInfo { path?: string; agents: AgentId[] }
export function compileProfile(root: string, desired: Desired, infoOf: (name: string) => SkillInfo | undefined = () => undefined): FileChange[] {
  const skills = desired.skills ?? {}, plugins = desired.plugins ?? {};
  for (const k of [...Object.keys(skills), ...Object.keys(plugins)]) if (!/^[\w.@ -]{1,120}$/.test(k)) throw new Error(`unsafe tool name: ${k}`);
  for (const v of Object.values(skills)) if (v !== 'on' && v !== 'off' && v !== 'name-only') throw new Error(`unknown state: ${String(v)}`);
  if (!Object.keys(skills).length && !Object.keys(plugins).length) return [];
  const out: FileChange[] = [];

  const cpath = join(root, ...CLAUDE_FILE);
  let cfg: ClaudeLocal & Record<string, unknown> = {};
  try { cfg = JSON.parse(readText(cpath) ?? '{}') as typeof cfg; } catch { throw new Error('.claude/settings.local.json is not valid JSON; refusing to overwrite'); }
  const so: Record<string, string> = { ...(cfg.skillOverrides ?? {}) }, ep: Record<string, boolean> = { ...(cfg.enabledPlugins ?? {}) };
  for (const [n, st] of Object.entries(skills)) { if (st === 'on') delete so[n]; else if (infoOf(n)?.agents.includes('claude') ?? true) so[n] = st; }
  for (const [id, on] of Object.entries(plugins)) { if (on) delete ep[id]; else ep[id] = false; }
  const next: Record<string, unknown> = { ...cfg };
  if (Object.keys(so).length) next['skillOverrides'] = so; else delete next['skillOverrides'];
  if (Object.keys(ep).length) next['enabledPlugins'] = ep; else delete next['enabledPlugins'];
  out.push(change(cpath, JSON.stringify(next, null, 2) + '\n', 'tools hidden for this project (Claude, personal file, not for git)'));

  const xpath = join(root, '.codex', 'config.toml');
  const text = readText(xpath) ?? '';
  const cur = readCodexBlock(root);
  const sk = new Set(cur.skills), pg = new Set(cur.plugins);
  for (const [n, st] of Object.entries(skills)) { const i = infoOf(n); if (!i?.path || !i.agents.includes('codex')) continue; if (st === 'off') sk.add(i.path); else sk.delete(i.path); }
  for (const [id, on] of Object.entries(plugins)) { if (on) pg.delete(id); else pg.add(id); }
  const body = [...sk].map((p) => `[[skills.config]]\npath = ${tomlStr(p)}\nenabled = false\n`).concat([...pg].map((id) => `[plugins."${id}"]\nenabled = false\n`)).join('\n');
  const block = body ? `# >>> agent-hub:plugin-profile\n${body}# <<< agent-hub:plugin-profile\n` : '';
  const had = BLOCK.test(text);
  if (block || had) out.push(change(xpath, had ? text.replace(BLOCK, block) : `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${block}`, 'tools switched off for this project (Codex; project-level override NOT verified)'));
  return out;
}
