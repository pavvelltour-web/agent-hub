import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { redact } from '../lib/redact.ts';
import { HUB_HOME } from '../core/registry.ts';

/** Hooks the hub itself runs around an agent session. They exist for agents (or events) with no native hook support. */
export interface RunnerHooks { sessionStart: string[][]; sessionEnd: string[][] }
export interface HookResult { event: string; command: string; code: number | null; output: string }

const argvList = (v: unknown): string[][] => (Array.isArray(v) ? v.filter((c): c is string[] => Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === 'string')) : []);
const empty = (h: RunnerHooks): boolean => !h.sessionStart.length && !h.sessionEnd.length;

/** Reads `hooks` from the project's hub.json. A hub.json can come from a cloned repository, so these are NOT run until approved here. */
export function readRunnerHooks(root: string, home: string = HUB_HOME): RunnerHooks & { approved: boolean } {
  let hooks: RunnerHooks = { sessionStart: [], sessionEnd: [] };
  try {
    const h = (JSON.parse(readFileSync(join(root, 'hub.json'), 'utf8')) as { hooks?: Record<string, unknown> }).hooks ?? {};
    hooks = { sessionStart: argvList(h['sessionStart']), sessionEnd: argvList(h['sessionEnd']) };
  } catch { /* no hub.json or not valid */ }
  return { ...hooks, approved: empty(hooks) || approvals(home)[rootKey(root)] === digest(hooks) };
}

const rootKey = (root: string): string => resolve(root).replace(/\\/g, '/').toLowerCase();
const digest = (h: RunnerHooks): string => createHash('sha256').update(JSON.stringify([h.sessionStart, h.sessionEnd])).digest('hex');
const approvalFile = (home: string): string => join(home, 'hooks-approved.json');
const approvals = (home: string): Record<string, string> => { try { return JSON.parse(readFileSync(approvalFile(home), 'utf8')) as Record<string, string>; } catch { return {}; } };

/** Record that the user reviewed exactly these hooks for this project on this machine. Any later change to them needs a new approval. */
export function approveRunnerHooks(root: string, home: string = HUB_HOME): RunnerHooks {
  const h = readRunnerHooks(root, home);
  mkdirSync(dirname(approvalFile(home)), { recursive: true });
  writeFileSync(approvalFile(home), JSON.stringify({ ...approvals(home), [rootKey(root)]: digest(h) }, null, 1));
  return { sessionStart: h.sessionStart, sessionEnd: h.sessionEnd };
}

/** Run each command as an argument array (never a shell string). A failing hook is reported, it never blocks the agent. */
export function runHooks(event: string, cmds: string[][], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): HookResult[] {
  return cmds.map((c) => {
    const r = spawnSync(c[0] as string, c.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    return { event, command: c.join(' '), code: r.error ? null : r.status, output: redact(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error.message) : ''}`.trim()).slice(0, 300) };
  });
}
