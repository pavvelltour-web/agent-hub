import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isSafeName } from '../lib/paths.ts';
import { change, readText } from './plan.ts';
import { REPO_ROOT } from './registry.ts';
import type { FileChange, McpSpec, RegistryEntry } from './types.ts';

const TITLES: Record<string, string> = { 'web-saas': 'Web / SaaS', 'mobile-app': 'Mobile app', automation: 'Automation / agents', 'design-study': 'Design study' };

/** AGENTS.md text for a project type: shared rules (rules/base.md) + the rules of that kind of work (rules/<type>.md). */
export function renderRules(name: string, type?: string): string {
  const read = (f: string): string => { try { return readFileSync(join(REPO_ROOT, 'rules', f), 'utf8'); } catch { return ''; } };
  const typeRules = type && TITLES[type] ? read(`${type}.md`).trim() : '';
  return read('base.md').replaceAll('{{name}}', name).replaceAll('{{title}}', (type && TITLES[type]) || 'general').replace('{{type_rules}}', typeRules).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const projectType = (root: string): string | undefined => { try { return (JSON.parse(readText(join(root, 'hub.json')) ?? '{}') as { project?: { type?: string } }).project?.type; } catch { return undefined; } };

/** AGENTS.md is the single source of rules; CLAUDE.md only imports it. Existing files are never overwritten. */
export function compileRules(root: string, type?: string): FileChange[] {
  const out: FileChange[] = [];
  const agents = join(root, 'AGENTS.md');
  if (!existsSync(agents)) out.push(change(agents, renderRules(basename(root), type ?? projectType(root)), 'rules for all agents, written for this kind of project'));
  const claude = join(root, 'CLAUDE.md');
  const cur = readText(claude);
  if (cur === null) out.push(change(claude, '@AGENTS.md\n', 'Claude imports AGENTS.md'));
  else if (!cur.includes('@AGENTS.md')) out.push(change(claude, `${cur.replace(/\s*$/, '')}\n\n@AGENTS.md\n`, 'adds the AGENTS.md import line'));
  return out;
}

/** Link a local skill into both agents' project skill folders (junction; copy fallback is handled by applyPlan). */
export function compileSkill(root: string, e: RegistryEntry): FileChange[] {
  const name = e.id.split('/')[1] ?? '';
  if (e.kind !== 'skill' || !isSafeName(name) || e.source.type !== 'local' || !e.source.path) return [];
  return ['.claude', '.agents'].map((d) => ({ path: join(root, d, 'skills', name), action: 'link' as const, before: null, after: e.source.path as string, note: e.id }));
}

type McpJson = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;
const mcpName = (e: RegistryEntry): string => e.id.split('/')[1] ?? e.id;

/** Merge MCP servers into the project's `.mcp.json`. Env vars are referenced as ${VAR}; values never written. */
export function compileMcpClaude(root: string, entries: RegistryEntry[]): FileChange[] {
  const mcps = entries.filter((e) => e.kind === 'mcp' && e.mcp);
  if (!mcps.length) return [];
  const path = join(root, '.mcp.json');
  let cfg: McpJson = {};
  try { cfg = JSON.parse(readText(path) ?? '{}') as McpJson; } catch { throw new Error('.mcp.json is not valid JSON; refusing to overwrite'); }
  const servers = { ...(cfg.mcpServers ?? {}) } as Record<string, unknown>;
  for (const e of mcps) {
    const m = e.mcp as McpSpec;
    const env = Object.fromEntries((m.env ?? []).map((v) => [v, `\${${v}}`]));
    servers[mcpName(e)] = m.url ? { type: 'http', url: m.url } : { command: m.command, args: m.args ?? [], ...(m.env?.length ? { env } : {}) };
  }
  return [change(path, JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + '\n', 'MCP servers for Claude Code')];
}

const tomlStr = (s: string): string => JSON.stringify(s);
/** Replace/append one marker-delimited block per server in `.codex/config.toml`, leaving the rest of the file untouched. */
export function compileMcpCodex(root: string, entries: RegistryEntry[]): FileChange[] {
  const mcps = entries.filter((e) => e.kind === 'mcp' && e.mcp);
  if (!mcps.length) return [];
  const path = join(root, '.codex', 'config.toml');
  let text = readText(path) ?? '';
  for (const e of mcps) {
    const m = e.mcp as McpSpec, name = mcpName(e);
    const body = m.url ? `url = ${tomlStr(m.url)}` : `command = ${tomlStr(m.command ?? '')}\nargs = [${(m.args ?? []).map(tomlStr).join(', ')}]${m.env?.length ? `\nenv_vars = [${m.env.map(tomlStr).join(', ')}]` : ''}`;
    const block = `# >>> agent-hub:${name}\n[mcp_servers.${name}]\n${body}\n# <<< agent-hub:${name}\n`;
    const re = new RegExp(`# >>> agent-hub:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?# <<< agent-hub:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`);
    text = re.test(text) ? text.replace(re, block) : `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${block}`;
  }
  return [change(path, text, 'MCP servers for Codex (marker blocks)')];
}

/** Compile all selected entries into one list of file changes. */
export function compileAll(root: string, selected: RegistryEntry[], type?: string): FileChange[] {
  return [...compileRules(root, type), ...selected.flatMap((e) => compileSkill(root, e)), ...compileMcpClaude(root, selected), ...compileMcpCodex(root, selected)];
}

export const readJson = <T>(p: string, fallback: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; } };
