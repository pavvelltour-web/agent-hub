import { copyFileSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One scheduler per hub home (ADR-025). `RunManager.isLive` knows only the runs of its own process, so a second `hub ui` or CLI process over the same home would see the first
 * one's auto run as "not live", mark it finished and start the next one, and nobody would watch the 10 % margin. The loop therefore needs this lock: `<home>/autouse.lock`, created
 * with the exclusive `wx` flag, holding the owner's pid, its process start time and the time of its last heartbeat.
 *
 * A LIVE owner is never replaced, however old its heartbeat (the PC may have slept, a history sync may be long): the lock is taken over only when the owner's pid is not alive, or when a
 * start-time probe says the live process at that pid started later than the owner recorded (the pid was reused). Without a probe a live pid stays the owner: the lock may then be stuck
 * on a reused pid, which is the safe side; `lockStatus` reports it («другой процесс hub держит планировщик», and that it has been silent for LOCK_SILENT_MS) and the user can delete the file.
 * The heartbeat comes from its own timer (autouse-wire.ts), independent of the tick and of any sync.
 * Taking over a stale lock: move it aside, check that what was moved is what was checked (else give it back: a fresh lock of someone else was moved by mistake), then create exclusively.
 */
export const LOCK_SILENT_MS = 30 * 60_000;
export interface LockDeps {
  home: string; pid: number; now: () => number; alive: (pid: number) => boolean;
  /** This process's start time (ms), written into the lock. */
  startedMs?: number;
  /** Start time (ms) of the live process at a pid, or null when it cannot be told. */
  probe?: (pid: number) => number | null;
  /** Tests: runs between reading a stale lock and moving it aside. */
  beforeRename?: () => void;
}
interface Lock { pid: number; at: number; startedMs?: number; raw: string }
const file = (home: string): string => join(home, 'autouse.lock');
const readLock = (home: string): Lock | undefined => {
  try {
    const raw = readFileSync(file(home), 'utf8'), j = JSON.parse(raw) as { pid?: unknown; at?: unknown; startedMs?: unknown };
    return typeof j.pid === 'number' && Number.isInteger(j.pid) && typeof j.at === 'number' && Number.isFinite(j.at) ? { pid: j.pid, at: j.at, ...(typeof j.startedMs === 'number' && Number.isFinite(j.startedMs) ? { startedMs: j.startedMs } : {}), raw } : undefined;
  } catch { return undefined; }
};
const body = (d: LockDeps): string => JSON.stringify({ pid: d.pid, at: d.now(), ...(d.startedMs !== undefined ? { startedMs: d.startedMs } : {}) });
/** Is the owner of this lock really gone? A dead pid, or a live process that started after the owner did (a reused pid). */
const ownerGone = (d: LockDeps, cur: Lock): boolean => {
  if (!d.alive(cur.pid)) return true;
  if (d.probe && cur.startedMs !== undefined) { const t = d.probe(cur.pid); if (t !== null && Number.isFinite(t) && t - cur.startedMs > 5000) return true; }
  return false;
};

export type LockStatus = { state: 'own' | 'free' } | { state: 'other'; owner: number; silent: boolean };
/** Who holds the lock, as this process sees it (no side effects). `silent`: the owner is alive but has not refreshed the lock for a long time. */
export function lockStatus(d: LockDeps): { state: 'own' | 'free' | 'other'; owner: number | null; silent: boolean } {
  const cur = readLock(d.home);
  if (!cur || ownerGone(d, cur)) return { state: 'free', owner: null, silent: false };
  if (cur.pid === d.pid) return { state: 'own', owner: cur.pid, silent: false };
  return { state: 'other', owner: cur.pid, silent: d.now() - cur.at > LOCK_SILENT_MS };
}

/** Try to become the owner. `{ ok: false, owner }` when another process owns it (`owner` null when it cannot be read). */
export function acquireLock(d: LockDeps): { ok: true } | { ok: false; owner: number | null } {
  mkdirSync(d.home, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(file(d.home), body(d), { flag: 'wx' }); return { ok: true }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, owner: null }; }
    const cur = readLock(d.home);
    if (cur && cur.pid === d.pid) { writeFileSync(file(d.home), body(d)); return { ok: true }; }
    if (cur && !ownerGone(d, cur)) return { ok: false, owner: cur.pid };
    // stale (or unreadable): move it aside, make sure it is the one that was checked, then try to create again
    d.beforeRename?.();
    const aside = `${file(d.home)}.stale.${d.pid}.${Math.floor(d.now())}`;
    try { renameSync(file(d.home), aside); } catch { continue; }   // another process moved it first
    let moved = '';
    try { moved = readFileSync(aside, 'utf8'); } catch { /* unreadable: treat as the stale one */ }
    if (cur && moved !== cur.raw) {   // we moved a fresh lock that appeared after we checked: give it back (exclusively) and stand down
      try { copyFileSync(aside, file(d.home), constants.COPYFILE_EXCL); } catch { /* it was taken again: fine */ }
      rmSync(aside, { force: true });
      return { ok: false, owner: readLock(d.home)?.pid ?? null };
    }
    rmSync(aside, { force: true });
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
/** The heartbeat alone: rewrites the time of a lock this process owns, and does nothing otherwise (it never takes a lock). */
export function heartbeat(d: LockDeps): boolean {
  const cur = readLock(d.home);
  if (!cur || cur.pid !== d.pid) return false;
  try { writeFileSync(file(d.home), body(d)); return true; } catch { return false; }
}

export function releaseLock(d: LockDeps): void { if (readLock(d.home)?.pid === d.pid) try { rmSync(file(d.home), { force: true }); } catch { /* gone */ } }
export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** This process's own start time, as recorded in its lock. */
export const ownStartMs = (): number => Math.round(Date.now() - process.uptime() * 1000);
