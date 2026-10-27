import type { AuthInfo } from '../adapters/auth.ts';
import type { AgentId } from '../core/types.ts';
import { limitSnapshots } from '../econ/limits.ts';
import type { Db } from '../history/store.ts';
import { AutoScheduler, loadAuto, type AutoDeps } from './autouse.ts';
import type { RunManager } from './runner.ts';
import { billingOk, startReqFor, type LimitAt } from './scheduler.ts';

/** The real effects of the scheduler (ADR-025): the run goes through `RunManager.start`, like every other run (worktree branch, review gate, guardrails, limit checks). */
export function realAutoDeps(o: { db: Db; runs: RunManager; auth: (agent: AgentId) => AuthInfo | undefined; env?: NodeJS.ProcessEnv; breaker?: (root: string) => string | null }): AutoDeps {
  const { db, runs } = o;
  return {
    home: runs.home, now: Date.now,
    limits: () => {
      const out: Partial<Record<AgentId, LimitAt>> = {};
      for (const [a, l] of Object.entries(limitSnapshots(db)) as [AgentId, NonNullable<ReturnType<typeof limitSnapshots>[AgentId]>][]) out[a] = { usedPercent: l.usedPercent, reached: l.reached, resetsAt: l.resetsAt, ts: l.ts };
      return out;
    },
    billing: (agent) => billingOk(agent, o.auth(agent), o.env ?? process.env),
    breaker: o.breaker ?? (() => null),
    projectRoot: (id) => (db.prepare('SELECT root FROM project WHERE id = ?').get(id) as { root: string } | undefined)?.root,
    start: (job, root) => ({ runId: runs.start(startReqFor(job, root)).id }),
    stop: (id) => void runs.stop(id),
    runState: (id) => ({ live: runs.isLive(id), outcome: runs.get(id)?.outcome ?? null }),
  };
}

export const hasPending = (home: string): boolean => { const st = loadAuto(home); return st.items.some((i) => (i.status === 'approved' || i.status === 'started') && st.projects[i.projectKey]?.enabled === true); };

/**
 * The only real timer: one pass a minute while the panel process runs. `refresh` (history sync, so the limit readings are fresh) runs only when something is waiting.
 * A pass never overlaps the previous one and never throws. Returns `stop`. `setInt`/`clearInt` are injectable.
 */
export function startAutoLoop(sched: AutoScheduler, o: { home: string; refresh?: () => Promise<void>; everyMs?: number; refreshEveryMs?: number; now?: () => number; setInt?: typeof setInterval; clearInt?: typeof clearInterval }): () => void {
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
  return () => (o.clearInt ?? clearInterval)(t);
}
