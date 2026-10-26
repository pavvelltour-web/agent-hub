import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/** Checkpoint uncommitted work on the agent's own branch. Repo hooks are NOT skipped; if the commit is refused the card says so. */
export function checkpoint(cwd: string, message: string): { committed: boolean; sha: string; note?: string } {
  git(cwd, ['add', '-A']);
  if (!git(cwd, ['status', '--porcelain']).out) return { committed: false, sha: git(cwd, ['rev-parse', 'HEAD']).out };
  const c = git(cwd, ['-c', 'user.name=agent-hub', '-c', 'user.email=agent-hub@localhost', 'commit', '-m', message]);
  return c.ok ? { committed: true, sha: git(cwd, ['rev-parse', 'HEAD']).out } : { committed: false, sha: git(cwd, ['rev-parse', 'HEAD']).out, note: `commit refused: ${c.err.split('\n')[0] ?? ''}` };
}
