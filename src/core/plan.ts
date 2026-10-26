import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { safeJoin } from '../lib/paths.ts';
import type { FileChange, Plan } from './types.ts';

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Read a file as text, or null. */
export const readText = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

export const change = (path: string, after: string, note?: string): FileChange => {
  const before = readText(path);
  return { path, action: before === null ? 'create' : 'update', before, after, ...(note ? { note } : {}) };
};

/** Drop no-op changes so the user is never shown a diff that changes nothing. */
export const effective = (plan: Plan): Plan => ({
  ...plan,
  changes: plan.changes.filter((c) => c.action === 'link' ? !(isLink(c.path) || existsSync(c.path)) : c.action === 'unlink' ? isLink(c.path) : c.before !== c.after),
});

export interface ApplyResult { backupId: string; written: string[]; fallbacks: string[] }

/**
 * Apply an APPROVED plan. Every path must stay inside `root` or one of `allowOutside`.
 * Originals are copied to `.hub/backups/<id>/` first; `undoBackup` restores them.
 */
export function applyPlan(plan: Plan, opts: { approved: boolean; allowOutside?: string[]; now?: () => Date }): ApplyResult {
  if (!opts.approved) throw new Error('plan not approved');
  const roots = [plan.root, ...(opts.allowOutside ?? [])];
  for (const c of plan.changes) if (!roots.some((r) => { try { safeJoin(r, relative(r, c.path)); return !relative(r, c.path).startsWith('..'); } catch { return false; } })) throw new Error(`path outside allowed roots: ${c.path}`);

  const id = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const bdir = join(plan.root, '.hub', 'backups', id);
  mkdirSync(join(bdir, 'files'), { recursive: true });
  const manifest: { path: string; existed: boolean; backup?: string; link?: boolean; linkTarget?: string }[] = [];
  const written: string[] = [];
  const fallbacks: string[] = [];

  plan.changes.forEach((c, i) => {
    const existed = existsSync(c.path) || isLink(c.path);
    const entry: (typeof manifest)[number] = { path: c.path, existed };
    if (c.action === 'unlink') { if (!isLink(c.path)) throw new Error(`not a link, will not delete: ${c.path}`); entry.linkTarget = readlinkSync(c.path); }
    if (existed && !isLink(c.path) && c.action !== 'link') { entry.backup = `files/${i}`; writeFileSync(join(bdir, entry.backup), readFileSync(c.path)); }
    manifest.push(entry);
  });
  writeFileSync(join(bdir, 'manifest.json'), JSON.stringify(manifest, null, 1));

  for (const c of plan.changes) {
    if (c.action === 'unlink') { unlinkSync(c.path); written.push(c.path); continue; }
    mkdirSync(dirname(c.path), { recursive: true });
    if (c.action === 'link') {
      if (isLink(c.path)) unlinkSync(c.path);
      try { symlinkSync(c.after, c.path, 'junction'); } catch { cpSync(c.after, c.path, { recursive: true }); fallbacks.push(c.path); }
    } else writeFileSync(c.path, c.after, 'utf8');
    written.push(c.path);
  }
  appendFileSync(join(plan.root, '.hub', 'audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), action: 'apply-plan', backup: id, files: written.length }) + '\n');
  return { backupId: id, written, fallbacks };
}

/** Restore the state before `applyPlan(backupId)`: put back originals, remove what the plan created. */
export function undoBackup(root: string, backupId: string): { restored: number; removed: number } {
  const bdir = join(root, '.hub', 'backups', backupId);
  const manifest = JSON.parse(readFileSync(join(bdir, 'manifest.json'), 'utf8')) as { path: string; existed: boolean; backup?: string; linkTarget?: string }[];
  let restored = 0, removed = 0;
  for (const m of manifest.reverse()) {
    if (m.linkTarget !== undefined && !isLink(m.path) && !existsSync(m.path)) { try { symlinkSync(m.linkTarget, m.path, 'junction'); restored++; } catch { /* target gone: nothing to restore */ } continue; }
    if (isLink(m.path)) { unlinkSync(m.path); removed++; if (m.backup) { writeFileSync(m.path, readFileSync(join(bdir, m.backup))); restored++; } continue; }
    if (m.backup) { mkdirSync(dirname(m.path), { recursive: true }); writeFileSync(m.path, readFileSync(join(bdir, m.backup))); restored++; }
    else if (!m.existed && existsSync(m.path)) { rmSync(m.path, { recursive: true, force: true }); removed++; }
  }
  appendFileSync(join(root, '.hub', 'audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), action: 'undo', backup: backupId }) + '\n');
  return { restored, removed };
}

export const listBackups = (root: string): string[] => {
  const d = resolve(root, '.hub', 'backups');
  return existsSync(d) ? readdirSync(d).sort() : [];
};

/** Plain-text diff summary for CLI/UI (line counts, not a full patch). */
export function describe(plan: Plan): string[] {
  return plan.changes.map((c) => {
    const rel = relative(plan.root, c.path).replace(/\\/g, '/');
    if (c.action === 'link') return `link    ${rel} -> ${c.after}`;
    if (c.action === 'unlink') return `unlink  ${rel}`;
    const add = c.after.split('\n').length, del = c.before ? c.before.split('\n').length : 0;
    return `${c.action.padEnd(7)} ${rel}  (+${add} −${del})${c.note ? '  · ' + c.note : ''}`;
  });
}
