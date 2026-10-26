import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

/** The only folders whose files the session page may read: where Claude Code and Codex keep their conversation files. */
export const historyRoots = (home: string = homedir()): string[] => [join(home, '.claude', 'projects'), join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')];

export type Source = { path: string } | { moved: true } | { refused: string };

const real = (p: string): string | undefined => { try { return realpathSync.native(p); } catch { return undefined; } };

/**
 * Decide whether `sourcePath` (a value from our own index, never from a request) may be read.
 * The CANONICAL path (symlinks, junctions and `..` resolved) must lie inside one of the history roots.
 * A file that does not exist is `moved` (the person moved or deleted the conversation); everything else outside is `refused`.
 */
export function resolveSource(sourcePath: string, roots: string[] = historyRoots()): Source {
  if (!sourcePath || sourcePath.includes('\0')) return { refused: 'bad source path' };
  let canon: string;
  try { canon = realpathSync.native(sourcePath); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { moved: true } : { refused: 'source cannot be resolved' };
  }
  const inside = roots.map(real).some((r) => { if (!r) return false; const rel = relative(r, canon); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); });
  return inside ? { path: canon } : { refused: 'source is outside the agents\' history folders' };
}
