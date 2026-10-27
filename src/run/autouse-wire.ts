import type { AuthInfo } from '../adapters/auth.ts';
import type { AgentId } from '../core/types.ts';
import { limitSnapshots } from '../econ/limits.ts';
import type { Db } from '../history/store.ts';
import { blockingTrips } from './breaker.ts';
import { heartbeat, holdsLock, ownStartMs, pidAlive, releaseLock, type LockDeps } from './autouse-lock.ts';
import { AUTO_PROMPT_MARKS } from './scheduler.ts';
import { AutoScheduler, loadAuto, repoIdOf, type AutoDeps } from './autouse.ts';
import { agentEnv, type RunManager } from './runner.ts';
import { billingOk, projectSettingsProblem, startReqFor, type LimitAt } from './scheduler.ts';

/** The real effects of the scheduler (ADR-025): the run goes through `RunManager.start`, like every other run (worktree branch, review gate, guardrails, limit checks). */
export function realAutoDeps(o: { db: Db; runs: RunManager; auth: (agent: AgentId, root?: string) => AuthInfo | undefined; env?: NodeJS.ProcessEnv; breaker?: (root: string) => string | null }): AutoDeps {
  const { db, runs } = o;
  return {
    home: runs.home, now: Date.now, pid: process.pid, repoId: repoIdOf,
    alive: pidAlive, liveAutoRuns: () => liveAutoRunIds(db),
    lock: { hold: () => holdsLock(realLock(runs.home)) },
    limits: () => {
      const out: Partial<Record<AgentId, LimitAt>> = {};
      for (const [a, l] of Object.entries(limitSnapshots(db)) as [AgentId, NonNullable<ReturnType<typeof limitSnapshots>[AgentId]>][]) out[a] = { usedPercent: l.usedPercent, reached: l.reached, resetsAt: l.resetsAt, ts: l.ts, windowMinutes: l.windowMinutes };
      return out;
    },
    billing: (agent, root) => billingOk(agent, o.auth(agent, root), agentEnv(o.env ?? process.env)),   // the environment the run itself will get
    // a job in a worktree is cut from HEAD: its settings are the COMMITTED ones; a review runs in the folder itself
    projectCheck: (root, agent, kind) => (agent === 'claude' ? projectSettingsProblem(root, { source: kind === 'missing-tests' ? 'head' : 'files', home: runs.home }) : null),
    breaker: o.breaker ?? ((root) => blockingTrips(db, runs.home, root)[0]?.ru ?? null),   // the circuit breaker of ADR-026 (the start itself is checked again by the RunManager)
    projectRoot: (id) => (db.prepare('SELECT root FROM project WHERE id = ?').get(id) as { root: string } | undefined)?.root,
    start: (job, root) => ({ runId: runs.start(startReqFor(job, root)).id }),
    stop: (id) => void runs.stop(id),
    runState: (id) => ({ live: runs.isLive(id), outcome: runs.get(id)?.outcome ?? null }),
  };
}

/** The lock of this process (autouse-lock.ts). */
export const realLock = (home: string): LockDeps => ({ home, pid: process.pid, now: Date.now, alive: pidAlive, startedMs: ownStartMs() });

/** Live runs that look like automatic ones: unfinished runs of the scheduler's fixed prompts, optionally of one project. The run table, not the state file, so a forged state cannot hide them. */
export function liveAutoRunIds(db: Db, projectId?: number): string[] {
  const rows = db.prepare(`SELECT id, prompt FROM run WHERE outcome IS NULL ${projectId != null ? 'AND project_id = ?' : ''}`).all(...(projectId != null ? [projectId] : [])) as unknown as { id: string; prompt: string | null }[];
  return rows.filter((r) => typeof r.prompt === 'string' && AUTO_PROMPT_MARKS.some((m) => (r.prompt as string).startsWith(m))).map((r) => r.id);
}

export const hasPending = (home: string): boolean => { const st = loadAuto(home); return st.items.some((i) => (i.status === 'approved' || i.status === 'started') && st.projects[i.projectKey]?.enabled === true); };

/**
 * The only real timer: one pass a minute while the panel process runs. `refresh` (history sync, so the limit readings are fresh) runs only when something is waiting.
 * A pass never overlaps the previous one and never throws. Returns `stop`. `setInt`/`clearInt` are injectable.
 */
export function startAutoLoop(sched: AutoScheduler, o: { home: string; lock?: LockDeps; heartbeatEveryMs?: number; refresh?: () => Promise<void>; everyMs?: number; refreshEveryMs?: number; now?: () => number; setInt?: typeof setInterval; clearInt?: typeof clearInterval }): () => void {
  let busy = false, lastRefresh = 0;
  const now = o.now ?? Date.now;
  const pass = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      if (o.refresh && hasPending(o.home) && now() - lastRefresh >= (o.refreshEveryMs ?? 10 * 60_000)) { lastRefresh = now(); await o.refresh().catch(() => undefined); }
      sched.tick();
    } catch { /* the next pass tries again */ } finally { busy = false; }
  };
  const t = (o.setInt ?? setInterval)(() => void pass(), o.everyMs ?? 60_000);
  (t as { unref?: () => void }).unref?.();
  // the heartbeat of the lock has its OWN timer: a long history sync, a slow tick or a sleeping PC must not make a live owner look silent
  const hb = o.lock ? (o.setInt ?? setInterval)(() => { try { heartbeat(o.lock as LockDeps); } catch { /* next one */ } }, o.heartbeatEveryMs ?? 30_000) : undefined;
  (hb as { unref?: () => void } | undefined)?.unref?.();
  return () => { (o.clearInt ?? clearInterval)(t); if (hb) (o.clearInt ?? clearInterval)(hb); if (o.lock) releaseLock(o.lock); };
}
