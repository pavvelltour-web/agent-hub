import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Stable hash of a file or a directory tree (names + contents), ignoring `.git` and `node_modules`. */
export function hashPath(p: string): string {
  const h = createHash('sha256');
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, `${rel}${name}/`);
      else h.update(`${rel}${name}\0`).update(readFileSync(full)).update('\0');
    }
  };
  if (statSync(p).isDirectory()) walk(p, '');
  else h.update(readFileSync(p));
  return h.digest('hex');
}
