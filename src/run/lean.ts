import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentId, RegistryEntry } from '../core/types.ts';
import type { WorkMode } from '../core/workmodes.ts';
import { HUB_HOME, loadCatalog, shippedCatalogIds } from '../core/registry.ts';

export interface LeanOpts {
  projectRoot: string; cwd: string;
  /** MCP servers this task needs. Only names the mode lists are honoured: a caller can narrow the mode, never widen it. */
  mcpNeeded: string[];
  /** Task class: only used when there is no work mode (a mode's own `skills` list decides otherwise). */
  cls?: string;
  /** Where the temporary MCP file goes; default `<hub home>/tmp`. Never the project folder. */
  tmpDir?: string;
  /** Definitions of MCP servers, from the hub library only (injectable for tests). Default: the shipped catalog, then the hub home (shipped wins on an id collision). */
  catalog?: RegistryEntry[];
  /** Ids in `catalog` that come from the shipped catalog; only those may have `sourceVerified: false`. Default: the shipped catalog's ids. */
  shippedIds?: string[];
  /** Tests: the platform and the user-profile folder the Windows temp-file rule uses (default: this machine). */
  platform?: NodeJS.Platform; profile?: string;
}
export interface LeanPlan { args: string[]; notes: string[]; cleanup: () => void }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const URL_OK = /^https:\/\/[^\s"'`<>\\${}]{1,500}$/;
const CTRL = /[\x00-\x1f\x7f]/;
const ROTE = new Set(['mechanical', 'summary']);
/** Shells and script hosts: a server whose `command` is one of these is a one-liner runner, not a server. Refused whatever its arguments. */
const LAUNCHERS = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'wscript', 'cscript', 'mshta', 'wsl']);
const launcher = (command: string): boolean => LAUNCHERS.has((command.trim().split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, ''));

/**
 * One server for `--mcp-config`, built from a hub-library entry (`mcp/<name>`). Environment variables are written ONLY as the `${NAME}`
 * references this function generates (names validated), so the file holds names and never values; Claude Code expands them from the
 * (already filtered) process environment. A `$` anywhere in the entry's own command, arguments or url is refused: otherwise an entry could
 * smuggle `${ANTHROPIC_API_KEY}` into a url or an argument and have the CLI expand it. Also refused: a url that is not https, a shell
 * launcher as the command, control characters, and an entry whose source is unverified unless it is in the shipped catalog.
 * The project's own `.mcp.json` is NOT a source: a repository could name a hostile command under a known server name, and `--mcp-config`
 * is trusted without the approval prompt that project-scoped servers get. Returns the server, or the reason it was refused.
 */
function serverFor(name: string, catalog: RegistryEntry[], shipped: Set<string>): { server: Record<string, unknown> } | { why: string } {
  if (!NAME.test(name)) return { why: 'bad name' };
  const e = catalog.find((x) => x.kind === 'mcp' && x.id === `mcp/${name}`);
  const m = e?.mcp;
  if (!e || !m) return { why: 'not in the hub library' };
  if (e.sourceVerified !== true && !shipped.has(e.id)) return { why: 'unverified source' };
  const bad = { why: 'unsafe definition' };
  if (m.url !== undefined) return typeof m.url === 'string' && URL_OK.test(m.url) && !CTRL.test(m.url) ? { server: { type: 'http', url: m.url } } : bad;
  if (typeof m.command !== 'string' || !m.command.trim() || m.command.includes('$') || CTRL.test(m.command) || launcher(m.command)) return bad;
  const args = m.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('$') || CTRL.test(a))) return bad;
  const env = m.env ?? [];
  if (!Array.isArray(env) || env.some((v) => typeof v !== 'string' || !ENV_NAME.test(v))) return bad;
  return { server: { command: m.command, args, ...(env.length ? { env: Object.fromEntries(env.map((v) => [v, '${' + v + '}'])) } : {}) } };
}

/** `dir` is inside `profile`: case-insensitive, on a path boundary (`C:\Users\a-evil` is not inside `C:\Users\a`). */
const inside = (dir: string, profile: string): boolean => {
  const d = dir.toLowerCase().replace(/\\/g, '/'), p = profile.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return d === p || d.startsWith(p + '/');
};
const canon = (p: string): string => { try { return realpathSync.native(p); } catch { return resolve(p); } };
/** Canonical form of a path that may not exist yet: the deepest existing ancestor resolved (junctions, short names), the rest appended. */
const canonDeep = (p: string): string => {
  const abs = resolve(p), tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) { const up = dirname(cur); if (up === cur) return abs; tail.unshift(basename(cur)); cur = up; }
  return join(canon(cur), ...tail);
};

/** Removes temp MCP files the hub left behind (a crash): only its own name pattern, only regular files, only older than a day. */
export function sweepStaleMcp(dir: string, now: number = Date.now()): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/^mcp-[0-9a-f]{16}\.json$/.test(n)) continue;
    try { const f = join(dir, n), st = lstatSync(f); if (st.isFile() && now - st.mtimeMs > 86_400_000) rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Extra Claude Code flags that keep a hub-started run lean. Flags are the ones `claude --help` lists on this machine (observed, v2.1.114);
 * their effect on a live session was not measured here (the CLI was not logged in).
 *  - Tasks run in a git worktree, which does NOT contain the project's personal `.claude/settings.local.json` (it is not committed).
 *    Without it the worktree run would load every global plugin again, so the project's profile is passed explicitly with `--settings`.
 *  - Skills are on or off, not filtered per skill: a mode whose `skills` is empty gets `--disable-slash-commands`; any non-empty list
 *    (`["*"]` is the explicit "all") keeps them. Without a mode the old rule stays: rote work (mechanical, summary) drops skills.
 *  - A mode that names MCP servers (`mcp` is set, even `[]`) always gets `--strict-mcp-config`; with servers needed it also gets
 *    `--mcp-config <file>` holding only those. If any needed server cannot be built from the hub library, or the file cannot be written
 *    safely, NO MCP server starts (strict, no file) and `notes` says why: never fail-open to the user's whole set, never a half list.
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
  if (mode?.mcp) {
    const needed = [...new Set(o.mcpNeeded)].filter((n) => mode.mcp?.includes(n));
    let file: string | undefined;
    if (needed.length) {
      let catalog = o.catalog;
      if (!catalog) { try { catalog = loadCatalog(); } catch { catalog = []; } }
      let shipped: Set<string>;
      try { shipped = new Set(o.shippedIds ?? (o.catalog ? [] : shippedCatalogIds())); } catch { shipped = new Set(); }
      const servers: [string, Record<string, unknown>][] = [], refused: string[] = [];
      for (const n of needed) {
        const r = serverFor(n, catalog, shipped);
        if ('server' in r) servers.push([n, r.server]); else refused.push(`${JSON.stringify(String(n).slice(0, 64))} (${r.why})`);
      }
      if (refused.length) notes.push(`MCP: ${refused.join(', ')} cannot be started from the hub library, so no MCP server starts in this run`);
      else {
        const platform = o.platform ?? process.platform, dir = resolve(o.tmpDir ?? join(HUB_HOME, 'tmp'));
        // 0600 is ignored on Windows: the file is protected by the folder's ACL, which is the user profile's. Outside it, refuse.
        const profile = canon(o.profile ?? homedir());
        const outside = platform === 'win32' && !inside(canonDeep(dir), profile);
        if (outside) notes.push('MCP: the hub folder is outside your user profile, where Windows file permissions cannot be relied on, so no MCP server starts in this run');
        else {
          try {
            mkdirSync(dir, { recursive: true });
            if (platform === 'win32' && !inside(canon(dir), profile)) throw new Error('outside the profile');   // a junction can point out of it
            const f = join(dir, `mcp-${randomBytes(8).toString('hex')}.json`);
            writeFileSync(f, JSON.stringify({ mcpServers: Object.fromEntries(servers) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            file = f;
            cleanup = (): void => { try { rmSync(f, { force: true }); } catch { /* best effort: it holds names only */ } };
          } catch { notes.push('MCP: could not write the temporary config safely, so no MCP server starts in this run'); }
        }
      }
    }
    args.push('--strict-mcp-config', ...(file ? ['--mcp-config', file] : []));
  }
  return { args, notes, cleanup };
}

/** The flags only. When a temporary MCP file is written, the caller removes it: use `leanPlan` to get `cleanup`. */
export const leanArgs = (agent: AgentId, mode: WorkMode | undefined, o: LeanOpts): string[] => leanPlan(agent, mode, o).args;
