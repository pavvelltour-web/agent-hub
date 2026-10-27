import { spawnSync } from 'node:child_process';
import type { AgentId } from '../core/types.ts';
import type { AgentInfo } from './locate.ts';

/** Is the agent CLI signed in? Both CLIs answer a status command that needs no network call and prints no secrets. */
export interface AuthInfo { loggedIn: boolean | null; how: string }
export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string };

const run: Runner = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true }); return { status: r.status, stdout: (r.stdout ?? '') + (r.stderr ?? '') }; };

export function parseAuth(id: AgentId, r: { status: number | null; stdout: string }): AuthInfo {
  if (id === 'claude') {
    try { const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string }; return { loggedIn: !!j.loggedIn, how: j.loggedIn ? String(j.authMethod ?? 'account') : '' }; } catch { return { loggedIn: null, how: '' }; }
  }
  const t = r.stdout.trim();
  if (/logged in/i.test(t) && !/not logged in/i.test(t)) return { loggedIn: true, how: t.replace(/^logged in (using )?/i, '').slice(0, 40) };
  return { loggedIn: /not logged in/i.test(t) ? false : r.status === 0 ? null : false, how: '' };
}

const cache = new Map<string, { at: number; v: AuthInfo }>();
export function authStatus(id: AgentId, info: AgentInfo, runner: Runner = run, now = Date.now()): AuthInfo {
  if (!info.installed || !info.path) return { loggedIn: null, how: '' };
  const hit = cache.get(id);
  if (hit && runner === run && now - hit.at < 20_000) return hit.v;
  const v = parseAuth(id, runner(info.path, id === 'claude' ? ['auth', 'status'] : ['login', 'status']));
  if (runner === run) cache.set(id, { at: now, v });
  return v;
}
/** The same check made FROM a project folder (not cached): that is where an automatic run will start, and a folder's own Claude settings can change the answer. */
export function authStatusIn(id: AgentId, info: AgentInfo, cwd: string, runner?: RunnerIn, env?: NodeJS.ProcessEnv): AuthInfo {
  if (!info.installed || !info.path) return { loggedIn: null, how: '' };
  // Claude: only the USER settings (as the run itself), so a project's .claude/settings cannot change the answer; the environment is the one the run gets, not the whole process environment. `--setting-sources` on `auth status` is NOT verified live.
  const args = id === 'claude' ? ['auth', 'status', '--setting-sources', 'user'] : ['login', 'status'];
  const r = (runner ?? ((cmd, a, o) => { const x = spawnSync(cmd, a, { encoding: 'utf8', timeout: 15_000, windowsHide: true, ...(o?.cwd ? { cwd: o.cwd } : {}), ...(o?.env ? { env: o.env } : {}) }); return { status: x.status, stdout: (x.stdout ?? '') + (x.stderr ?? '') }; }))(info.path, args, { cwd, ...(env ? { env } : {}) });
  return parseAuth(id, r);
}
export type RunnerIn = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => { status: number | null; stdout: string };
export const forgetAuth = (id: AgentId): void => void cache.delete(id);
