import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashPath } from '../lib/hash.ts';
import { compileAll } from './compilers.ts';
import { effective, readText } from './plan.ts';
import { library } from './registry.ts';
import type { Lock, Plan } from './types.ts';

export interface InstallItem { id: string; status: 'ok' | 'hash-changed' | 'missing-source' | 'not-in-library'; detail: string }

/**
 * Re-create what `hub.lock.json` records (skill links, MCP settings) on a fresh clone or another machine.
 * A source whose content hash differs from the lock is NOT installed: changed code must be re-approved through `hub init`.
 */
export function planInstall(root: string): { plan: Plan; items: InstallItem[] } {
  const raw = readText(join(root, 'hub.lock.json'));
  if (!raw) throw new Error('no hub.lock.json here: run `hub init` first');
  const lock = JSON.parse(raw) as Lock;
  const byId = new Map(library(root).map((e) => [e.id, e]));
  const items: InstallItem[] = [];
  const ok = [];
  for (const l of lock.entries) {
    const e = byId.get(l.id);
    if (!e) { items.push({ id: l.id, status: 'not-in-library', detail: 'not found in the library on this machine (install the skill/MCP first)' }); continue; }
    if (e.source.type === 'local') {
      const p = e.source.path;
      if (!p || !existsSync(p)) { items.push({ id: l.id, status: 'missing-source', detail: `source folder is missing: ${p ?? '?'}` }); continue; }
      if (l.hash && hashPath(p) !== l.hash) { items.push({ id: l.id, status: 'hash-changed', detail: 'content differs from what you approved; re-approve with `hub init`' }); continue; }
    }
    items.push({ id: l.id, status: 'ok', detail: l.hash ? 'hash matches the lock' : 'no hash recorded (remote source)' });
    ok.push(e);
  }
  return { plan: effective({ root, changes: compileAll(root, ok), notes: [] }), items };
}
