import type { AgentId } from '../core/types.ts';
import { latestLimitMin, type Db } from '../history/store.ts';

/** A window of at least this many minutes counts as the WEEKLY one (a 7-day window is 10080; 6 days leaves room for a plan that reports a little less). */
export const WEEKLY_MIN_MINUTES = 6 * 1440;

export { claudeWindowMinutes } from '../adapters/event-utils.ts';

/**
 * The newest WEEKLY limit reading per agent (window length known and >= 6 days). A newer reading of a shorter window, or one with no window length, is not the weekly limit and
 * is ignored here: whatever uses this (the forecast, the leftover-limit scheduler) compares percentages of the WEEK. A reading whose reset time has passed is stale and its percent
 * is unknown (never carried over). `resetsAt` is epoch seconds.
 */
export interface LimitSnap { usedPercent: number | null; reached: boolean; resetsAt: number | null; windowMinutes: number; ts: string; stale: boolean; source: string }

export function limitSnapshots(db: Db, now: number = Date.now()): Partial<Record<AgentId, LimitSnap>> {
  const out: Partial<Record<AgentId, LimitSnap>> = {};
  for (const a of ['claude', 'codex'] as AgentId[]) {
    const l = latestLimitMin(db, a, WEEKLY_MIN_MINUTES);
    if (!l || l.windowMinutes == null) continue;
    const stale = l.resetsAt != null && l.resetsAt * 1000 < now;
    out[a] = { usedPercent: stale ? null : l.usedPercent, reached: !stale && (l.usedPercent ?? 0) >= 100, resetsAt: l.resetsAt, windowMinutes: l.windowMinutes, ts: l.ts, stale, source: l.source };
  }
  return out;
}
