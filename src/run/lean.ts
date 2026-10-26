import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentId } from '../core/types.ts';

/**
 * Extra Claude Code flags that keep a hub-started run lean. Flags are the ones `claude --help` lists on this machine; the effect on a
 * live session was not measured here (the CLI was not logged in).
 *  - Tasks run in a git worktree, which does NOT contain the project's personal `.claude/settings.local.json` (it is not committed).
 *    Without it the worktree run would load every global plugin again, so the project's profile is passed explicitly with `--settings`.
 *  - Rote work (renames, formatting, summaries) never needs skills: `--disable-slash-commands` removes the whole skill listing.
 * Codex: no verified per-run switch for skills, so nothing is passed (the project's .codex/config.toml applies when the run is in the project folder).
 */
export function leanArgs(agent: AgentId, cls: string | undefined, o: { projectRoot: string; cwd: string }): string[] {
  if (agent !== 'claude') return [];
  const out: string[] = [];
  const local = join(o.projectRoot, '.claude', 'settings.local.json');
  if (resolve(o.cwd).toLowerCase() !== resolve(o.projectRoot).toLowerCase() && existsSync(local)) out.push('--settings', local);
  if (cls === 'mechanical' || cls === 'summary') out.push('--disable-slash-commands');
  return out;
}
