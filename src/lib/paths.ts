import { isAbsolute, relative, resolve } from 'node:path';

/** Normalize a Windows/POSIX path from any agent store: strips `\\?\`, unifies slashes, lowercases the drive. */
export function norm(p: string): string {
  let s = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  s = s.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase() + ':').replace(/\/{2,}/g, '/');
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Comparison key: Windows paths are case-insensitive. */
export const pathKey = (p: string): string => (/^[a-z]:/i.test(norm(p)) ? norm(p).toLowerCase() : norm(p));

/** Join `parts` under `root`; throws if the result escapes `root` (traversal, absolute parts, NUL). */
export function safeJoin(root: string, ...parts: string[]): string {
  for (const p of parts) if (p.includes('\0')) throw new Error('path contains NUL');
  const full = resolve(root, ...parts);
  const rel = relative(resolve(root), full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes root: ${parts.join('/')}`);
  return full;
}

const SECRET = /(^|[\\/])(auth\.json|\.credentials\.json|secrets?|\.sandbox-secrets|\.env(\..+)?|id_rsa|id_ed25519|\.npmrc|\.netrc)([\\/]|$)/i;
/** Paths the hub must never read or index. */
export const isSecretPath = (p: string): boolean => SECRET.test(p);

/** Branch/task name part: conservative allow-list, no leading dash or dot, no `..`. */
export const isSafeName = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) && !s.includes('..');
