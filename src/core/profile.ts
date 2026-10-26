import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { readText } from './plan.ts';
import { REPO_ROOT } from './registry.ts';
import type { AgentId } from './types.ts';

export interface PluginInfo { id: string; name: string; enabled: boolean; skills: number; tokens: number; suggestDisable: boolean }

const home = (): string => process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir();
const suggest = (type?: string): Set<string> => { try { const j = JSON.parse(readFileSync(join(REPO_ROOT, 'registry', 'plugin-profile.json'), 'utf8')) as { suggestDisable: string[]; keepFor?: Record<string, string[]> }; const keep = new Set((type && j.keepFor?.[type]) || []); return new Set(j.suggestDisable.filter((x) => !keep.has(x))); } catch { return new Set(); } };

/** Skills and the tokens their descriptions cost per turn, from the newest cached version of a plugin. */
function skillCost(cacheRoot: string, id: string): { skills: number; tokens: number } {
  const [name, market] = id.split('@');
  const base = join(cacheRoot, market ?? '', name ?? '');
  if (!existsSync(base)) return { skills: 0, tokens: 0 };
  const ver = readdirSync(base).sort().at(-1);
  const sk = ver ? join(base, ver, 'skills') : '';
  if (!sk || !existsSync(sk)) return { skills: 0, tokens: 0 };
  let skills = 0, chars = 0;
  for (const d of readdirSync(sk)) {
    const t = readText(join(sk, d, 'SKILL.md'));
    if (t === null) continue;
    const fm = parseFrontmatter(t); skills++; chars += (fm['name'] ?? d).length + Math.min((fm['description'] ?? '').length, 1536);
  }
  return { skills, tokens: Math.ceil(chars / 4) };
}

/** Plugins enabled at user level for each agent, with what they cost per turn. Read-only. */
export function listPlugins(projectType?: string): Record<AgentId, PluginInfo[]> {
  const sg = suggest(projectType);
  const out: Record<AgentId, PluginInfo[]> = { claude: [], codex: [] };
  try {
    const j = JSON.parse(readFileSync(join(home(), '.claude', 'settings.json'), 'utf8')) as { enabledPlugins?: Record<string, boolean> };
    for (const [id, on] of Object.entries(j.enabledPlugins ?? {})) out.claude.push({ id, name: id.split('@')[0] ?? id, enabled: !!on, ...skillCost(join(home(), '.claude', 'plugins', 'cache'), id), suggestDisable: sg.has(id.split('@')[0] ?? '') });
  } catch { /* no Claude settings */ }
  const toml = readText(join(home(), '.codex', 'config.toml')) ?? '';
  for (const m of toml.matchAll(/^\[plugins\."([^"]+)"\]\s*\nenabled\s*=\s*(true|false)/gm)) {
    const id = m[1] as string;
    out.codex.push({ id, name: id.split('@')[0] ?? id, enabled: m[2] === 'true', ...skillCost(join(home(), '.codex', 'plugins', 'cache'), id), suggestDisable: sg.has(id.split('@')[0] ?? '') });
  }
  return out;
}
