import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { graphStatus } from '../core/graph.ts';
import { applyPlan } from '../core/plan.ts';
import type { AgentId } from '../core/types.ts';
import { isSafeName } from '../lib/paths.ts';
import { planJournalWrite, readJournal, renderSteps } from '../run/journal.ts';
import { buildFullMap } from '../run/map.ts';
import { REVIEWER_MODE } from '../run/runner.ts';
import type { Ctx, Handler, Res } from './api.ts';

/**
 * Routes of the orchestrator map (ADR-027), kept out of api.ts like phase7-api.ts. Type-only imports from api.ts: nothing circular at run time.
 * GET /api/map reads only. POST /api/map/message resumes a finished hub run with the person's text; it needs the panel's own click (`meta.userAction`) on top of the cookie,
 * and goes through RunManager.start, so the circuit breaker and the concurrency cap apply as for any run.
 */
const ok = (json: unknown): Res => ({ status: 200, json });
const bad = (status: number, error: string): Res => ({ status, json: { error } });
const needClick = bad(403, 'this must come from the panel itself (same-origin request from its own code)');
const RUN_ID = /^r[0-9a-z]{2,40}$/;
const ABOUT = /^(sub|bg):(r[0-9a-z]{2,40}):([A-Za-z0-9_.:-]{1,200})$/;   // a native node of a run: sub-agent or background shell, then the tool call id
const MAX_TEXT = 8000;

export const mapRoutes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/map$/, (c: Ctx, { q }) => {
    const pq = q.get('projectId');
    if (!pq || !/^\d+$/.test(pq)) return bad(400, 'projectId required');
    const p = c.db.prepare('SELECT root FROM project WHERE id = ?').get(Number(pq)) as { root: string } | undefined;
    if (!p) return bad(404, 'project not found');
    const root = q.get('root');
    if (root !== null && !RUN_ID.test(root)) return bad(400, 'bad run id');
    const mq = q.get('max');
    const map = buildFullMap(c.db, c.runs.home, { projectId: Number(pq), ...(root ? { root } : {}), ...(mq && /^\d+$/.test(mq) ? { max: Number(mq) } : {}) });
    try {   // the hub's own background job: the graph update (single flight, ADR-021)
      const g = graphStatus(p.root);
      if (g.running || g.last) map.nodes.push({ id: 'hub:graph', kind: 'hubjob', label: 'Обновление графа', status: g.running ? 'running' : g.last?.ok ? 'done' : 'failed', goal: 'Пересборка графа проекта (graphify, без модели)', why: 'hub background job', context: null, messageable: false, ...(g.last ? { detail: g.last.message.slice(0, 200) } : {}) });
    } catch { /* no graph information: no node */ }
    return ok(map);
  }],

  ['POST', /^\/api\/map\/message$/, (c: Ctx, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    const runId = typeof body['runId'] === 'string' ? body['runId'] : '';
    if (!RUN_ID.test(runId)) return bad(400, 'bad run id');
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (!text || text.length > MAX_TEXT) return bad(400, `text: 1 to ${MAX_TEXT} characters`);
    let prompt = text;
    if (body['about'] !== undefined) {   // a native node cannot be reached: the text goes to the run that owns it and names the node
      const m = typeof body['about'] === 'string' ? ABOUT.exec(body['about']) : null;
      if (!m || m[2] !== runId) return bad(400, 'about: a sub-agent or background process of this run');
      prompt = `Regarding your ${m[1] === 'sub' ? 'sub-agent' : 'background process'} "${m[3]}": ${text}`;
    }
    const run = c.runs.get(runId);
    if (!run) return bad(404, 'run not found');
    if (run.workMode === REVIEWER_MODE) return bad(400, 'reviewer runs cannot be messaged');
    if (run.endedAt == null) return bad(409, 'the run is still running: wait for it to finish or stop it first');
    if (!run.sessionNativeId) return bad(400, 'this run has no session to continue');
    const root = (c.db.prepare('SELECT root FROM project WHERE id = ?').get(run.projectId ?? -1) as { root: string } | undefined)?.root;
    if (!root) return bad(400, 'the run has no project folder');
    try { return ok({ run: c.runs.start({ agent: run.agent as AgentId, prompt, projectRoot: root, resumeRunId: runId }) }); } catch (e) { return bad(400, (e as Error).message); }
  }],

  // The step journal: a preview of what would be written into the project's specs/, and the approved write (digest of the shown text, backup and undo as for any plan).
  ['GET', /^\/api\/journal$/, (c: Ctx, { q }) => {
    const found = journalTarget(c, q.get('projectId'), q.get('task'));
    if ('error' in found) return found.error;
    const j = readJournal(c.runs.home, String(found.id), found.task);
    const plan = planJournalWrite(found.root, found.task, j.entries), ch = plan.changes[0];
    return ok({ entries: j.entries, truncated: j.truncated, markdown: renderSteps(j.entries), plan: ch ? { path: relative(found.root, ch.path).replace(/\\/g, '/'), action: ch.action, digest: digestOf(ch.after) } : null });
  }],
  ['POST', /^\/api\/journal\/apply$/, (c: Ctx, { body, meta }) => {
    if (!meta?.userAction) return needClick;
    if (body['approved'] !== true) return bad(400, 'approve needs approved: true');
    const found = journalTarget(c, typeof body['projectId'] === 'number' ? String(body['projectId']) : null, typeof body['task'] === 'string' ? body['task'] : null);
    if ('error' in found) return found.error;
    const plan = planJournalWrite(found.root, found.task, readJournal(c.runs.home, String(found.id), found.task).entries);
    if (typeof body['digest'] !== 'string' || body['digest'] !== digestOf(plan.changes[0]?.after ?? '')) return bad(409, 'the journal changed since you looked at it; review it again');
    try { const r = applyPlan(plan, { approved: true }); return ok({ written: r.written.map((w) => relative(found.root, w).replace(/\\/g, '/')), backupId: r.backupId }); } catch (e) { return bad(400, (e as Error).message); }
  }],
];

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');
function journalTarget(c: Ctx, pq: string | null, task: string | null): { id: number; root: string; task: string } | { error: Res } {
  if (!pq || !/^\d+$/.test(pq)) return { error: bad(400, 'projectId required') };
  if (!task || !isSafeName(task)) return { error: bad(400, 'task: letters, digits, dot, dash, underscore') };
  const p = c.db.prepare('SELECT root FROM project WHERE id = ?').get(Number(pq)) as { root: string } | undefined;
  return p ? { id: Number(pq), root: p.root, task } : { error: bad(404, 'project not found') };
}
