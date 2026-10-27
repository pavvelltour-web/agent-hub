import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentId } from '../core/types.ts';
import { isSecretPath, pathKey } from '../lib/paths.ts';
import { fileState, hasTamper, recordTamper, sealThenRename } from './integrity.ts';
import { git } from './git.ts';
import { APPROVAL_TTL_MS, MAX_STARTS_PER_DAY, SAFETY_MARGIN_PCT, STARTABLE, eligibility, leftPct, validJob, type LimitAt, type QueuedJob, type Why } from './scheduler.ts';

/**
 * State and tick of the «use the leftover limit» scheduler (Phase 7.4, ADR-025).
 * The opt-in and the approvals live in `<hub home>/autouse.json`, written only by the user's own clicks (routes in phase7-api.ts) and read by the scheduler; a project's
 * `hub.json` is never read here, so a cloned repository cannot switch anything on. `tick()` is synchronous and takes every effect as an injected function (clock, limits,
 * spawner), so tests need no timers; the only real timer is the loop in the CLI (autouse-wire.ts).
 */
export type Status = 'approved' | 'started' | 'finished' | 'stopped' | 'expired' | 'cancelled' | 'failed-to-start';
const STATUSES = new Set<string>(['approved', 'started', 'finished', 'stopped', 'expired', 'cancelled', 'failed-to-start']);
export interface AutoItem extends QueuedJob { projectKey: string; projectRoot: string; approvedAt: number; status: Status; runId?: string; /** the process that started it (only the holder of the lock ticks) */ ownerPid?: number; startedAt?: number; endedAt?: number; outcome?: string; note?: string }
/** `repo`: the first-commit sha of the repository the user switched this folder on for (null: not a git repository). The opt-in follows the REPOSITORY: a different one at the same path drops it. */
export interface AutoProject { enabled: boolean; at: number; root: string; repo?: string }
export interface AutoState { version: 1; projects: Record<string, AutoProject>; items: AutoItem[]; starts: number[] }

const FILE = 'autouse.json', MAX_BYTES = 512 * 1024, MAX_ITEMS = 200, MAX_STARTS = 100, KEEP_MS = 14 * 86400_000, DAY_MS = 86400_000;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** Canonical key of a project folder (real path where it exists, lower-cased drive letter, forward slashes). */
export function projectKeyOf(root: string): string {
  let p = root;
  try { p = realpathSync(root); } catch { p = resolve(root); }
  return pathKey(p);
}
/** The word the user types to switch a project on: its folder name. */
export const confirmWordFor = (root: string): string => (root.split(/[\\/]+/).filter(Boolean).pop() ?? '').normalize('NFC');

const emptyState = (): AutoState => ({ version: 1, projects: {}, items: [], starts: [] });

/** Read and validate. Never throws: a missing, oversized or malformed file is an empty state (everything off), a bad row is dropped on its own. */
/** The first commit of the repository at `root` (the identity of the repo, not of the folder); null when it is not a git repository or has no commit. */
export function repoIdOf(root: string): string | null {
  const r = git(root, ['rev-list', '--max-parents=0', 'HEAD']);
  const first = r.ok ? r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l)).sort()[0] : undefined;
  return first ?? null;
}

/**
 * The state the hub wrote. A file the hub did not write (its hash does not match the seal, or it was never sealed) is NOT read: everything reads as OFF, the change is recorded
 * once and the panel says so until the user resets (integrity.ts). This is tamper evidence, not a hard boundary.
 */
export function loadAuto(home: string): AutoState {
  if (fileState(home, FILE) === 'changed') { recordTamper(home, FILE); return emptyState(); }
  return loadAutoRaw(home);
}

/** Read and validate without the integrity gate (the validation itself is tested through this). Never throws. */
export function loadAutoRaw(home: string): AutoState {
  const out = emptyState();
  try {
    const file = join(home, FILE);
    if (statSync(file).size > MAX_BYTES) return out;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const projects = raw['projects'];
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [k, v] of Object.entries(projects as Record<string, unknown>).slice(0, 200)) {
        const p = v as Record<string, unknown> | null;
        // `enabled` must be the boolean true, with the root it was switched on for, and the key must be that root's key: nothing loose switches a project on
        if (p && typeof p === 'object' && p['enabled'] === true && typeof p['root'] === 'string' && fin(p['at']) && pathKey(p['root']) === k) out.projects[k] = { enabled: true, at: p['at'], root: p['root'], ...(typeof p['repo'] === 'string' && /^[0-9A-Za-z._-]{1,80}$/.test(p['repo']) ? { repo: p['repo'] } : {}) };
      }
    }
    for (const x of (Array.isArray(raw['items']) ? raw['items'] : []).slice(-MAX_ITEMS)) {
      const i = x as Record<string, unknown> | null;
      if (!validJob(x) || !i || typeof i['projectKey'] !== 'string' || typeof i['projectRoot'] !== 'string' || !fin(i['approvedAt']) || typeof i['status'] !== 'string' || !STATUSES.has(i['status'])) continue;
      const it: AutoItem = { id: x.id, kind: x.kind, projectId: x.projectId, agent: x.agent, expectedPct: x.expectedPct, writes: x.writes, projectKey: i['projectKey'] as string, projectRoot: i['projectRoot'] as string, approvedAt: i['approvedAt'] as number, status: i['status'] as Status };
      if (typeof i['ownerPid'] === 'number' && Number.isSafeInteger(i['ownerPid']) && i['ownerPid'] > 0) it.ownerPid = i['ownerPid'];
      if (typeof i['runId'] === 'string' && /^r[0-9a-z]{2,40}$/.test(i['runId'])) it.runId = i['runId'];
      for (const k of ['startedAt', 'endedAt'] as const) if (fin(i[k])) it[k] = i[k] as number;
      if (typeof i['outcome'] === 'string') it.outcome = clip(oneLine(i['outcome']), 40);
      if (typeof i['note'] === 'string') it.note = clip(oneLine(i['note']), 200);
      out.items.push(it);
    }
    out.starts = (Array.isArray(raw['starts']) ? raw['starts'] : []).filter((t): t is number => fin(t) && t >= 0).slice(-MAX_STARTS);
  } catch { /* an empty state */ }
  return out;
}

/** Atomic: a temp file in the same folder, then a rename. Old finished rows and starts are dropped so the file stays small. */
export function saveAuto(home: string, st: AutoState, now = Date.now()): void {
  const items = st.items.filter((i) => i.status === 'approved' || i.status === 'started' || now - (i.endedAt ?? i.startedAt ?? i.approvedAt) < KEEP_MS).slice(-MAX_ITEMS);
  mkdirSync(home, { recursive: true });
  const file = join(home, FILE), tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, projects: st.projects, items, starts: st.starts.filter((t) => now - t < 2 * DAY_MS).slice(-MAX_STARTS) }, null, 1), 'utf8');
  sealThenRename(home, FILE, tmp);   // seal the new content first, then move it into place: the file in place is never an unsealed one for more than an instant
}

export const isEnabled = (st: AutoState, root: string): boolean => st.projects[projectKeyOf(root)]?.enabled === true;

/**
 * The per-project switch. Only the route that requires `meta.userAction` (a request from the panel's own code) calls this with `true` (it checks the typed folder name first). Turning it off cancels every approval
 * that had not started, so switching it on again later starts from nothing.
 */
export function setEnabled(home: string, root: string, enabled: boolean, now: number, o: { stop?: (runId: string) => void; repoId?: string | null } = {}): AutoState {
  const st = loadAuto(home), key = projectKeyOf(root);
  if (enabled) {
    if (isSecretPath(root) || !existsSync(root) || !statSync(root).isDirectory()) throw new Error('this folder cannot be switched on');
    st.projects[key] = { enabled: true, at: now, root, ...(typeof o.repoId === 'string' ? { repo: o.repoId } : {}) };
  } else {
    delete st.projects[key];
    for (const i of st.items) {
      if (i.projectKey !== key) continue;
      if (i.status === 'approved') { i.status = 'cancelled'; i.endedAt = now; }
      else if (i.status === 'started') { stopRun(i, o.stop, 'проект выключили: запуск остановлен', now); }   // switching off also stops the run that is live
    }
  }
  saveAuto(home, st, now);
  return st;
}

/** Store a user-approved job. The project must be switched on; the job must be valid (a known kind, `writes` as the kind allows, a known percent). */
export function approveItem(home: string, job: QueuedJob, root: string, now: number, o: { repoId?: string | null } = {}): AutoItem {
  if (!validJob(job)) throw new Error('not a valid job');
  const st = loadAuto(home), key = projectKeyOf(root);
  if (!st.projects[key]?.enabled) throw new Error('the project is not enabled for this');
  if ('repoId' in o && (st.projects[key]?.repo ?? null) !== (o.repoId ?? null)) throw new Error('в этой папке теперь другой репозиторий (the repository changed): включите заново');
  if (st.items.some((i) => i.id === job.id)) throw new Error('this approval already exists');
  const item: AutoItem = { id: job.id, kind: job.kind, projectId: job.projectId, agent: job.agent, expectedPct: job.expectedPct, writes: job.writes, projectKey: key, projectRoot: root, approvedAt: now, status: 'approved' };
  st.items.push(item);
  saveAuto(home, st, now);
  return item;
}
export const newItemId = (): string => `au${randomBytes(4).toString('hex')}`;

/** Stop a started auto run through the normal stop path and record it. */
function stopRun(i: AutoItem, stop: ((runId: string) => void) | undefined, note: string, now: number): void {
  if (i.runId) try { stop?.(i.runId); } catch { /* the run is gone */ }
  i.status = 'stopped'; i.endedAt = now; i.note = note;
}

/** Cancel an approval that has not started, or stop one that is running (through `stop`, the normal stop path). */
export function cancelItem(home: string, id: string, now = Date.now(), stop?: (runId: string) => void): boolean {
  const st = loadAuto(home), it = st.items.find((i) => i.id === id);
  if (!it || (it.status !== 'approved' && it.status !== 'started')) return false;
  if (it.status === 'started') stopRun(it, stop, 'вы отменили: запуск остановлен', now);
  else { it.status = 'cancelled'; it.endedAt = now; }
  saveAuto(home, st, now);
  return true;
}

// ---------- the tick ----------
export interface AutoDeps {
  home: string; now: () => number;
  limits: () => Partial<Record<AgentId, LimitAt>>;
  /** Is this agent on a subscription (not a paid key)? See billingOk. */
  billing: (agent: AgentId, root?: string) => { ok: boolean; why?: string };
  /** A reason when the project folder's own settings could change billing or run commands for this agent, else null (see projectSettingsProblem). */
  projectCheck?: (root: string, agent: AgentId, kind: QueuedJob['kind']) => string | null;
  /** The circuit breaker (7.5): a reason when starts are blocked for this folder, else null. */
  breaker: (root: string) => string | null;
  projectRoot: (projectId: number) => string | undefined;
  /** Starts the run through the RunManager; may throw (guardrail, too many runs, a folder that is not a git repository). */
  start: (job: QueuedJob, root: string) => { runId: string };
  stop: (runId: string) => void;
  /** The identity of the repository at a folder (see repoIdOf). Absent: not checked. */
  repoId?: (root: string) => string | null;
  /** The lock that makes one process the only scheduler over this home (autouse-lock.ts), and this process's pid. Absent: no lock (tests of one instance). */
  lock?: { hold: () => boolean };
  pid?: number;
  /** Is a process alive? A started item whose owner is another LIVE process is never judged by this one. */
  alive?: (pid: number) => boolean;
  /** Ids of live runs that look like automatic ones (the run table: the scheduler's fixed prompts, not finished): so that a tampered state file cannot hide a live run from the loop. */
  liveAutoRuns?: () => string[];
  runState: (runId: string) => { live: boolean; outcome: string | null };
}
export interface TickReport { started: { itemId: string; runId: string }[]; stopped: { itemId: string; why: string }[]; skipped: { itemId?: string; why: string; detail?: string }[]; expired: string[] }

const toJob = (i: AutoItem): QueuedJob => ({ id: i.id, kind: i.kind, projectId: i.projectId, agent: i.agent, expectedPct: i.expectedPct, writes: i.writes });

export class AutoScheduler {
  private d: AutoDeps;
  /** Run ids this instance started (kept in memory, not in the file that may be forged). */
  private mine = new Set<string>();
  constructor(deps: AutoDeps) { this.d = deps; }

  /** One pass: drop old approvals, look after the run that is live (stop it under the margin), and start at most ONE approved item if everything allows it. */
  tick(): TickReport {
    const d = this.d, now = d.now(), rep: TickReport = { started: [], stopped: [], skipped: [], expired: [] };
    if (d.lock && !d.lock.hold()) { rep.skipped.push({ why: 'not-owner' }); return rep; }   // another process is the scheduler: this one neither starts nor judges its runs
    const st = loadAuto(d.home);
    if (hasTamper(d.home, FILE)) {
      // the state file cannot be trusted, but a run it started can still be live: stop it (the normal stop path), do not leave it unwatched
      for (const id of new Set([...this.mine, ...(d.liveAutoRuns?.() ?? [])])) {
        let live = false; try { live = d.runState(id).live; } catch { live = false; }
        if (live) { try { d.stop(id); } catch { /* gone */ } rep.stopped.push({ itemId: id, why: 'файл настроек изменён не hub: запуск остановлен' }); }
      }
      this.mine.clear(); rep.skipped.push({ why: 'tamper' }); return rep;
    }
    let dirty = false;
    for (const i of st.items) if (i.status === 'approved' && now - i.approvedAt > APPROVAL_TTL_MS) { i.status = 'expired'; i.endedAt = now; rep.expired.push(i.id); dirty = true; }

    let limits: Partial<Record<AgentId, LimitAt>> = {};
    try { limits = d.limits() ?? {}; } catch { limits = {}; }   // an unreadable limit is an unknown limit
    for (const i of st.items.filter((x) => x.status === 'started' && x.runId)) {
      const rs = d.runState(i.runId as string);
      if (!rs.live && i.ownerPid !== undefined && d.pid !== undefined && i.ownerPid !== d.pid && d.alive?.(i.ownerPid)) continue;   // a run of another LIVE process: never marked finished here
      dirty = true;
      if (!rs.live) { i.status = 'finished'; i.endedAt = now; i.outcome = rs.outcome ?? 'unknown'; continue; }
      const left = leftPct(limits[i.agent], now);
      if (left === null || left < SAFETY_MARGIN_PCT) {
        try { d.stop(i.runId as string); } catch { /* the run is gone */ }
        i.status = 'stopped'; i.endedAt = now; i.note = left === null ? 'лимит не удалось прочитать' : `осталось ${Math.round(left)} % лимита: меньше запаса`;
        rep.stopped.push({ itemId: i.id, why: i.note });
      }
    }
    const finish = (): TickReport => { if (dirty) saveAuto(d.home, st, now); return rep; };

    if (st.items.some((i) => i.status === 'started')) { rep.skipped.push({ why: 'busy' }); return finish(); }
    st.starts = st.starts.filter((t) => now - t < DAY_MS);
    if (st.starts.length >= MAX_STARTS_PER_DAY) { rep.skipped.push({ why: 'daily-cap' }); dirty = true; return finish(); }

    for (const it of st.items.filter((x) => x.status === 'approved').sort((a, b) => a.approvedAt - b.approvedAt)) {
      if (!st.projects[it.projectKey]?.enabled) { rep.skipped.push({ itemId: it.id, why: 'not-enabled' }); continue; }
      if (!STARTABLE[it.kind]) { rep.skipped.push({ itemId: it.id, why: 'not-startable' }); continue; }
      const root = d.projectRoot(it.projectId);
      if (!root || !existsSync(root) || projectKeyOf(root) !== it.projectKey) { it.status = 'cancelled'; it.endedAt = now; it.note = 'папка проекта изменилась или пропала'; dirty = true; rep.skipped.push({ itemId: it.id, why: 'project-moved' }); continue; }
      if (d.repoId && (st.projects[it.projectKey]?.repo ?? null) !== d.repoId(root)) {
        delete st.projects[it.projectKey];
        for (const x of st.items) if (x.projectKey === it.projectKey && x.status === 'approved') { x.status = 'cancelled'; x.endedAt = now; x.note = 'в папке другой репозиторий'; }
        dirty = true; rep.skipped.push({ itemId: it.id, why: 'repo-changed' }); continue;
      }
      const e = eligibility(toJob(it), { limits, queue: [], now });
      if (!e.ok) { rep.skipped.push({ itemId: it.id, why: (e as { why: Why }).why }); continue; }
      const pc = d.projectCheck?.(root, it.agent, it.kind);
      if (pc) { rep.skipped.push({ itemId: it.id, why: 'project-settings', detail: pc }); continue; }
      const b = d.billing(it.agent, root);
      if (!b.ok) { rep.skipped.push({ itemId: it.id, why: 'billing', ...(b.why ? { detail: b.why } : {}) }); continue; }
      const br = d.breaker(root);
      if (br) { rep.skipped.push({ itemId: it.id, why: 'breaker', detail: br }); continue; }
      if (fileState(d.home, FILE) !== 'ok') { rep.skipped.push({ itemId: it.id, why: 'tamper' }); break; }   // checked again right before the start
      dirty = true;
      try {
        const r = d.start(toJob(it), root);
        if (d.pid !== undefined) it.ownerPid = d.pid;
        this.mine.add(r.runId);
        it.status = 'started'; it.runId = r.runId; it.startedAt = now; st.starts.push(now);
        rep.started.push({ itemId: it.id, runId: r.runId });
      } catch (err) { it.status = 'failed-to-start'; it.endedAt = now; it.note = clip(oneLine((err as Error).message), 200); rep.skipped.push({ itemId: it.id, why: 'start-failed', detail: it.note }); }
      break;   // one start per tick, whatever happened
    }
    return finish();
  }
}
