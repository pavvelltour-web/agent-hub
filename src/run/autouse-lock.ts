import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One scheduler per hub home (ADR-025). `RunManager.isLive` knows only the runs of its own process, so a second `hub ui` or CLI process over the same home would see the first
 * one's auto run as "not live", mark it finished and start the next one, and nobody would watch the 10 % margin. The loop therefore needs this lock: `<home>/autouse.lock`, created
 * with the exclusive `wx` flag, holding the owner's pid and the time of its last heartbeat (every tick that holds it rewrites it).
 * Stale: the owner's pid is not alive, or the heartbeat is older than LOCK_STALE_MS (a pid can be reused by an unrelated process, which then looks alive; a reused pid does not heartbeat).
 * Process start time is not read (no portable way without running a program). A stale lock is taken over by moving it aside first (a rename succeeds for one process only), then
 * creating a new one exclusively; a process always re-reads the file before acting, so one that lost a race does not tick.
 */
export const LOCK_STALE_MS = 3 * 60_000;
export interface LockDeps { home: string; pid: number; now: () => number; alive: (pid: number) => boolean }
const file = (home: string): string => join(home, 'autouse.lock');
const readLock = (home: string): { pid: number; at: number } | undefined => {
  try { const j = JSON.parse(readFileSync(file(home), 'utf8')) as { pid?: unknown; at?: unknown }; return typeof j.pid === 'number' && Number.isInteger(j.pid) && typeof j.at === 'number' && Number.isFinite(j.at) ? { pid: j.pid, at: j.at } : undefined; } catch { return undefined; }
};
const body = (d: LockDeps): string => JSON.stringify({ pid: d.pid, at: d.now() });

/** Try to become the owner. `{ ok: false, owner }` when a live, fresh lock of another process exists (`owner` null when it cannot be read). */
export function acquireLock(d: LockDeps): { ok: true } | { ok: false; owner: number | null } {
  mkdirSync(d.home, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(file(d.home), body(d), { flag: 'wx' }); return { ok: true }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, owner: null }; }
    const cur = readLock(d.home);
    if (cur && cur.pid === d.pid) { writeFileSync(file(d.home), body(d)); return { ok: true }; }
    if (cur && d.alive(cur.pid) && d.now() - cur.at <= LOCK_STALE_MS) return { ok: false, owner: cur.pid };
    // stale (or unreadable): move it aside, then try to create again
    const aside = `${file(d.home)}.stale.${d.pid}.${Math.floor(d.now())}`;
    try { renameSync(file(d.home), aside); rmSync(aside, { force: true }); } catch { /* another process moved it first */ }
  }
  return { ok: false, owner: readLock(d.home)?.pid ?? null };
}

/** Does this process own the lock right now? Refreshes the heartbeat when it does, and tries to take a missing or stale lock when it does not. */
export function holdsLock(d: LockDeps): boolean {
  const cur = readLock(d.home);
  if (cur && cur.pid === d.pid) { try { writeFileSync(file(d.home), body(d)); } catch { return false; } return readLock(d.home)?.pid === d.pid; }
  const got = acquireLock(d);
  return got.ok && readLock(d.home)?.pid === d.pid;
}

export function releaseLock(d: LockDeps): void { if (readLock(d.home)?.pid === d.pid) try { rmSync(file(d.home), { force: true }); } catch { /* gone */ } }
export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
