import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { HUB_HOME } from '../core/registry.ts';
import { isSafeName } from '../lib/paths.ts';

export interface GitResult { ok: boolean; out: string; err: string }
/** Run git with an argument array (never a shell string). */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: env ?? process.env, timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export const isGitRepo = (dir: string): boolean => existsSync(dir) && git(dir, ['rev-parse', '--is-inside-work-tree']).out === 'true';
export const repoRoot = (dir: string): string => git(dir, ['rev-parse', '--show-toplevel']).out;

export const branchName = (task: string, agent: string): string => {
  if (!isSafeName(task) || !isSafeName(agent)) throw new Error(`unsafe task or agent name: ${task} / ${agent}`);
  return `hub/${task}/${agent}`;
};

/** Sparse paths must be plain relative folders: no option-like names, no `..`, no absolute paths, no credential folders. */
export function checkSparse(paths: string[]): string[] {
  return paths.map((x) => {
    const p = x.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p || p.startsWith('-') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.git') || /(^|\/)(secrets?|\.ssh|\.aws)(\/|$)/i.test(p) || /[\u0000*?\[\]!]/.test(p)) throw new Error(`sparse path not allowed: ${x}`);
    return p;
  });
}

export interface Worktree { path: string; branch: string; baseSha: string }

/** `<repo>-worktrees/<task>-<agent>` next to the repo (same convention the author already uses). */
export function createWorktree(repo: string, task: string, agent: string, o: { sparse?: string[] } = {}): Worktree {
  const branch = branchName(task, agent);
  const root = repoRoot(repo);
  if (!root) throw new Error(`not a git repository: ${repo}`);
  const path = join(dirname(root), `${basename(root)}-worktrees`, `${task}-${agent}`);
  const baseSha = git(root, ['rev-parse', 'HEAD']).out;
  if (!baseSha) throw new Error('repository has no commits yet; make the first commit before running tasks in worktrees');
  mkdirSync(dirname(path), { recursive: true });
  const r = git(root, ['worktree', 'add', '-b', branch, path, baseSha]);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.err}`);
  if (o.sparse?.length) {
    const sp = checkSparse(o.sparse);
    git(path, ['sparse-checkout', 'init', '--cone']);
    const s = git(path, ['sparse-checkout', 'set', ...sp]);
    if (!s.ok) throw new Error(`sparse-checkout failed: ${s.err}`);
  }
  return { path, branch, baseSha };
}

export const removeWorktree = (repo: string, path: string): GitResult => git(repoRoot(repo), ['worktree', 'remove', '--force', path]);

/**
 * Environment that makes `git push` fail for everything the agent spawns, without touching any repo or user config:
 * GIT_CONFIG_* points core.hooksPath at a pre-push hook that always refuses.
 */
export function pushGuardEnv(hubDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = join(hubDir, 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pre-push'), '#!/bin/sh\necho "agent-hub: git push is disabled for agents. Ask the user to push." >&2\nexit 1\n', { mode: 0o755 });
  return { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: dir.replace(/\\/g, '/') };
}

export interface Facts { head: string; branch: string; changed: { status: string; path: string }[]; dirty: boolean; diffStat: string }
/** Deterministic facts for a handoff card: no model involved. */
export function facts(cwd: string, baseSha?: string): Facts {
  const head = git(cwd, ['rev-parse', 'HEAD']).out;
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const status = git(cwd, ['status', '--porcelain', '-uall']).out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  const committed = baseSha ? git(cwd, ['diff', '--name-status', `${baseSha}..HEAD`]).out.split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split('\t'); return { status: s ?? '?', path: p.join('\t') }; }) : [];
  // The hub's own folder (.hub/) is not the agent's work.
  const byPath = new Map([...committed, ...status].filter((c) => !c.path.startsWith('.hub/')).map((c) => [c.path, c]));
  return { head, branch, changed: [...byPath.values()], dirty: status.length > 0, diffStat: git(cwd, ['diff', '--stat', baseSha ? `${baseSha}` : 'HEAD']).out.split('\n').slice(-1)[0] ?? '' };
}

/** Every path except the hub's own folder: what a checkpoint may stage and what "uncommitted work" means. */
export const NOT_HUB_DIR = ['--', '.', ':(exclude).hub'];

/**
 * Checkpoint uncommitted work on the agent's own branch. The hub's own `.hub/` (handoff cards, audit) is never committed, even if the agent
 * staged it. No repository hook runs (`core.hooksPath` = an empty folder, `--no-verify`): hooks such as husky's are files of the branch, i.e.
 * the agent's code, and must not run before anyone looked at them. Git runs with the allowlisted env (`minimalEnv`) unless `o.env` is given.
 */
export function checkpoint(cwd: string, message: string, o: { home?: string; env?: NodeJS.ProcessEnv } = {}): { committed: boolean; sha: string; note?: string } {
  const env = o.env ?? minimalEnv();
  const noHooks = ['-c', `core.hooksPath=${noHooksDir(o.home ?? HUB_HOME)}`];
  const head = (): string => git(cwd, ['rev-parse', 'HEAD']).out;
  const first = (t: string): string => t.split(/\r?\n/)[0] ?? '';
  // A failed `git add` (locked index, a file git cannot read) must never look like "nothing to commit": the work would be missing from the commit.
  const add = git(cwd, [...noHooks, '-c', 'core.fsmonitor=false', 'add', '-A', ...NOT_HUB_DIR], env);
  if (!add.ok) return { committed: false, sha: head(), note: `git add failed: ${first(add.err)}` };
  git(cwd, [...noHooks, 'reset', '-q', '--', '.hub'], env);
  let committed = false;
  if (!git(cwd, ['diff', '--cached', '--quiet'], env).ok) {
    const c = git(cwd, [...noHooks, '-c', 'user.name=agent-hub', '-c', 'user.email=agent-hub@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', 'commit', '--no-verify', '-m', message], env);
    if (!c.ok) return { committed: false, sha: head(), note: `commit refused: ${first(c.err)}` };
    committed = true;
  }
  // Afterwards nothing but the hub's own folder may be left outside the commit.
  const left = git(cwd, ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '-uall', ...NOT_HUB_DIR], env);
  if (!left.ok || left.out) return { committed, sha: head(), note: `the working tree is not clean after the checkpoint (${left.ok ? first(left.out).trim() : first(left.err)})` };
  return { committed, sha: head() };
}

/**
 * Variables code from a branch (review checks, a checkpoint commit) may see: what node, npm, git and tsc need to start on Windows and POSIX.
 * An allowlist, so tokens and keys (GITHUB_TOKEN, NPM_TOKEN, cloud and model API keys), NODE_OPTIONS and npm_config_* never reach it.
 */
const ALLOWED_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TZ',
]);

/** The allowlisted part of `base`, plus `CI=1` (no prompts). Names match case-insensitively (Windows spells them `Path`, `SystemRoot`). */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && ALLOWED_ENV.has(k.toUpperCase())) out[k] = v;
  out['CI'] = '1';
  return out;
}

/**
 * Env for review checks: the allowlist + `git push` blocked (push-guard hook under `home`) + `NoDefaultCurrentDirectoryInExePath=1`, so cmd.exe
 * (npm's script shell on Windows) does not pick a `node.cmd` / `tsc.cmd` planted in the checks copy's own folder before PATH.
 */
export const checkEnv = (home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...pushGuardEnv(home, minimalEnv(base)), NoDefaultCurrentDirectoryInExePath: '1' });

/** An empty hooks folder under `home`: `-c core.hooksPath=<it>` makes git run no repository hook (husky's files are branch files). */
export function noHooksDir(home: string): string {
  const d = join(home, 'no-hooks');
  mkdirSync(d, { recursive: true });
  return d.replace(/\\/g, '/');
}
