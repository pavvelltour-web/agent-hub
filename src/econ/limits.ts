import type { AgentId } from '../core/types.ts';
import { latestLimit, type Db } from '../history/store.ts';

/** The newest limit reading per agent, as the panel's own `limitState` reads it: a reading whose reset time has passed is stale and its percent is unknown (never carried over). `resetsAt` is epoch seconds. */
export interface LimitSnap { usedPercent: number | null; reached: boolean; resetsAt: number | null; windowMinutes: number | null; ts: string; stale: boolean; source: string }

export function limitSnapshots(db: Db, now: number = Date.now()): Partial<Record<AgentId, LimitSnap>> {
  const out: Partial<Record<AgentId, LimitSnap>> = {};
  for (const a of ['claude', 'codex'] as AgentId[]) {
    const l = latestLimit(db, a);
    if (!l) continue;
    const stale = l.resetsAt != null && l.resetsAt * 1000 < now;
    out[a] = { usedPercent: stale ? null : l.usedPercent, reached: !stale && (l.usedPercent ?? 0) >= 100, resetsAt: l.resetsAt, windowMinutes: l.windowMinutes, ts: l.ts, stale, source: l.source };
  }
  return out;
}
