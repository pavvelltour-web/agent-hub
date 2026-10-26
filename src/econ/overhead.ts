import type { Db } from '../history/store.ts';

/**
 * What an agent really carries at the START of a conversation (system prompt, tool list, skills, plugins, rules), measured from the
 * user's own finished sessions: the size of the very first model call. This is the observed counterpart of the estimated "tokens per message".
 */
export interface Overhead { n: number; median: number | null; p25: number | null; p75: number | null }
const q = (a: number[], p: number): number | null => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? null : null);

export function startOverhead(db: Db, o: { projectId?: number } = {}): Record<'claude' | 'codex', Overhead> {
  const rows = db.prepare(`SELECT s.agent AS agent, u.uncached_in + u.cached_in AS first FROM usage_event u JOIN session s ON s.id = u.session_id
    WHERE u.id IN (SELECT MIN(id) FROM usage_event GROUP BY session_id) AND s.parent_id IS NULL AND u.model IS NOT NULL AND u.model NOT LIKE '<%'
    ${o.projectId != null ? 'AND s.project_id = ?' : ''}`).all(...(o.projectId != null ? [o.projectId] : [])) as unknown as { agent: string; first: number }[];
  const of = (agent: string): Overhead => { const v = rows.filter((r) => r.agent === agent && r.first > 0).map((r) => r.first).sort((a, b) => a - b); return { n: v.length, median: q(v, 0.5), p25: q(v, 0.25), p75: q(v, 0.75) }; };
  return { claude: of('claude'), codex: of('codex') };
}
