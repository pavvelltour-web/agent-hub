import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentId, RegistryEntry } from '../core/types.ts';
import type { WorkMode } from '../core/workmodes.ts';
import { HUB_HOME, loadCatalog } from '../core/registry.ts';

export interface LeanOpts {
  projectRoot: string; cwd: string;
  /** MCP servers this task needs. Only names the mode lists are honoured: a caller can narrow the mode, never widen it. */
  mcpNeeded: string[];
  /** Task class: only used when there is no work mode (a mode's own `skills` list decides otherwise). */
  cls?: string;
  /** Where the temporary MCP file goes; default `<hub home>/tmp`. Never the project folder. */
  tmpDir?: string;
  /** Definitions of MCP servers, from the hub library only (injectable for tests). */
  catalog?: RegistryEntry[];
}
export interface LeanPlan { args: string[]; notes: string[]; cleanup: () => void }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const URL_OK = /^https?:\/\/[^\s"'`<>\\]{1,500}$/;
const ROTE = new Set(['mechanical', 'summary']);

/**
 * One server for `--mcp-config`, built from a hub-library entry (`mcp/<name>`). Environment variables are written as `${NAME}` references,
 * so the file holds names and never values; Claude Code expands them from the (already filtered) process environment.
 * The project's own `.mcp.json` is NOT a source: a repository could name a hostile command under a known server name, and `--mcp-config`
 * is trusted without the approval prompt that project-scoped servers get. Anything odd returns undefined (refused).
 */
function serverFor(name: string, catalog: RegistryEntry[]): Record<string, unknown> | undefined {
  if (!NAME.test(name)) return undefined;
  const m = catalog.find((e) => e.kind === 'mcp' && e.id === `mcp/${name}`)?.mcp;
  if (!m) return undefined;
  if (m.url) return URL_OK.test(m.url) ? { type: 'http', url: m.url } : undefined;
  if (typeof m.command !== 'string' || !m.command.trim()) return undefined;
  const args = m.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return undefined;
  const env = m.env ?? [];
  if (!Array.isArray(env) || env.some((v) => typeof v !== 'string' || !ENV_NAME.test(v))) return undefined;
  return { command: m.command, args, ...(env.length ? { env: Object.fromEntries(env.map((v) => [v, `\${${v}}`])) } : {}) };
}

/**
 * Extra Claude Code flags that keep a hub-started run lean. Flags are the ones `claude --help` lists on this machine (observed, v2.1.114);
 * their effect on a live session was not measured here (the CLI was not logged in).
 *  - Tasks run in a git worktree, which does NOT contain the project's personal `.claude/settings.local.json` (it is not committed).
 *    Without it the worktree run would load every global plugin again, so the project's profile is passed explicitly with `--settings`.
 *  - A mode that lists no skills never needs them: `--disable-slash-commands` removes the whole skill listing. Without a mode the old
 *    rule stays: rote work (mechanical, summary) drops skills.
 *  - A mode that names MCP servers gets `--strict-mcp-config --mcp-config <file>` with only the servers the task needs. If any needed server
 *    cannot be built from the hub library, MCP is left exactly as it was and `notes` says why (never a half list that silently drops a tool).
 *    `--mcp-config` takes several values, so it is the last flag this function emits.
 * Codex: no per-run key for skills or MCP was verified (Task 1.2 verified sandbox and effort only), so nothing is passed.
 * `cleanup()` removes the temporary MCP file; the caller runs it when the process ends.
 */
export function leanPlan(agent: AgentId, mode: WorkMode | undefined, o: LeanOpts): LeanPlan {
  const none: LeanPlan = { args: [], notes: [], cleanup: () => {} };
  if (agent !== 'claude') return none;
  const args: string[] = [], notes: string[] = [];
  const local = join(o.projectRoot, '.claude', 'settings.local.json');
  if (resolve(o.cwd).toLowerCase() !== resolve(o.projectRoot).toLowerCase() && existsSync(local)) args.push('--settings', local);
  if (mode ? mode.skills.length === 0 : ROTE.has(o.cls ?? '')) args.push('--disable-slash-commands');
  let cleanup = (): void => {};
  const allowed = mode?.mcp ?? [];
  const needed = [...new Set(o.mcpNeeded)].filter((n) => allowed.includes(n));
  if (needed.length) {
    let catalog = o.catalog;
    if (!catalog) { try { catalog = loadCatalog(); } catch { catalog = []; } }
    const servers: [string, Record<string, unknown>][] = [], missing: string[] = [];
    for (const n of needed) { const s = serverFor(n, catalog); if (s) servers.push([n, s]); else missing.push(JSON.stringify(String(n).slice(0, 64))); }
    if (missing.length) notes.push(`MCP: ${missing.join(', ')} cannot be started from the hub library, so MCP settings are left as they are`);
    else {
      const dir = resolve(o.tmpDir ?? join(HUB_HOME, 'tmp'));
      const file = join(dir, `mcp-${randomBytes(8).toString('hex')}.json`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ mcpServers: Object.fromEntries(servers) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        args.push('--strict-mcp-config', '--mcp-config', file);
        cleanup = (): void => { try { rmSync(file, { force: true }); } catch { /* best effort: it holds names only */ } };
      } catch { notes.push('MCP: could not write the temporary config, so MCP settings are left as they are'); }
    }
  }
  return { args, notes, cleanup };
}

/** The flags only. When a temporary MCP file is written, the caller removes it: use `leanPlan` to get `cleanup`. */
export const leanArgs = (agent: AgentId, mode: WorkMode | undefined, o: LeanOpts): string[] => leanPlan(agent, mode, o).args;
