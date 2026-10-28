import { loadWorkModes, type WorkMode } from '../core/workmodes.ts';
import { HANDOFF_AT } from '../econ/context.ts';
import type { Db } from '../history/store.ts';
import { redact } from '../lib/redact.ts';
import { listCascades } from './cascade.ts';
import { goalOf } from './goal.ts';
import { REVIEWER_MODE } from './runner.ts';

/**
 * The map of one project's work (orchestrator-map design): a tree over what the hub already stores. Roots are runs nothing started (the orchestrators); children are runs
 * started for them: cascade rungs, review hunters and verifiers, handoff continuations, follow-up messages. Pure reading: nothing is written.
 */
export type NodeKind = 'orchestrator' | 'run' | 'subagent' | 'background' | 'hubjob' | 'mcp';
export interface MapNode {
  id: string; kind: NodeKind; label: string; agent?: string; model?: string; effort?: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | 'unfinished' | 'unknown';
  goal: string; why: string; branch?: string;
  /** Prompt size of the last model call vs the hub's handoff size; `null` = not measured. */
  context?: { used: number; limit: number } | null;
  costUsd?: number | null; messageable: boolean; runId?: string;
  /** One plain line for the drawer: what a sub-agent returned, how often a background shell was read. Redacted and clipped. */
  detail?: string;
  /** What the run's mode taught the agent: the rules files and the skills of that mode. */
  taught?: { rules: string[]; skills: string[]; skillsIfLinked?: string[] };
}
export interface MapEdge { from: string; to: string; reason: string }
export interface ProjectMap { nodes: MapNode[]; edges: MapEdge[]; truncated: number }

const MAX_ROWS = 2000, DEFAULT_MAX = 300, GOAL_MAX = 200;

interface Row { id: string; agent: string; model: string | null; effort: string | null; prompt: string | null; branch: string | null; startedAt: string; endedAt: string | null; outcome: string | null; sid: string | null; costUsd: number | null; handoffOf: string | null; resumeOf: string | null; mode: string | null; parentRun: string | null; spawnReason: string | null }

export { goalOf };

const statusOf = (r: Row): MapNode['status'] => {
  if (r.endedAt == null) return 'running';
  switch (r.outcome) {
    case 'done': case 'review': return 'done';
    case 'failed': case 'error': return 'failed';
    case 'limit': case 'context': case 'interrupted': case 'stopped': case 'guard': case 'guard-stop': case 'cancelled': return 'stopped';
    default: return 'unknown';
  }
};

const handoffReason = (prev: Row | undefined): string => (prev?.outcome === 'limit' ? 'handoff: limit' : prev?.outcome === 'context' ? 'handoff: context 250K' : 'handoff');

export function buildMap(db: Db, home: string, o: { projectId: number; root?: string; max?: number }): ProjectMap {
  const max = Number.isFinite(o.max) && (o.max as number) > 0 ? Math.min(Math.floor(o.max as number), 1000) : DEFAULT_MAX;
  const all = db.prepare(
    `SELECT id, agent, model, effort, prompt, branch, started_at AS startedAt, ended_at AS endedAt, outcome, session_native_id AS sid, cost_usd AS costUsd, handoff_of AS handoffOf, resume_of AS resumeOf, work_mode AS mode, parent_run AS parentRun, spawn_reason AS spawnReason
     FROM run WHERE project_id = ? ORDER BY started_at, id LIMIT ?`).all(o.projectId, MAX_ROWS) as unknown as Row[];
  // Reviewer runs show only as children of the run they reviewed; one without a parent (an older version's) is plumbing and stays out.
  const rows = all.filter((r) => r.mode !== REVIEWER_MODE || r.parentRun);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const parent = new Map<string, { id: string; reason: string }>();
  for (const s of listCascades(home)) {
    const first = s.rungs[0];
    if (!first || !byId.has(first.runId)) continue;
    for (const r of s.rungs.slice(1)) if (byId.has(r.runId) && r.runId !== first.runId && !parent.has(r.runId)) parent.set(r.runId, { id: first.runId, reason: r.repair ? 'repair after failed verify' : `escalation after failed verify: ${r.role}` });
  }
  for (const r of rows) {
    if (parent.has(r.id)) continue;
    if (r.parentRun && byId.has(r.parentRun)) parent.set(r.id, { id: r.parentRun, reason: r.spawnReason || 'spawned for another run' });
    else if (r.handoffOf && byId.has(r.handoffOf)) parent.set(r.id, { id: r.handoffOf, reason: handoffReason(byId.get(r.handoffOf)) });
    else if (r.resumeOf && byId.has(r.resumeOf)) parent.set(r.id, { id: r.resumeOf, reason: 'follow-up message' });
  }
  const children = new Map<string, Row[]>();
  for (const r of rows) { const p = parent.get(r.id); if (p) (children.get(p.id) ?? children.set(p.id, []).get(p.id)!).push(r); }

  // Walk from the roots; whatever is left over sits on a cycle of parent links and gets its oldest run as a root, so every run shows exactly once.
  const order: Row[] = [], reason = new Map<string, { from: string; reason: string }>(), seen = new Set<string>(), rootIds = new Set<string>();
  const walk = (start: Row): void => {
    rootIds.add(start.id); seen.add(start.id); order.push(start);
    for (let i = order.length - 1; i < order.length; i++) {
      for (const c of children.get((order[i] as Row).id) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id); order.push(c); reason.set(c.id, { from: (order[i] as Row).id, reason: (parent.get(c.id) as { reason: string }).reason });
      }
    }
  };
  if (o.root !== undefined) {
    if (!byId.has(o.root)) return { nodes: [], edges: [], truncated: 0 };
    let top = o.root; const up = new Set<string>();
    while (parent.has(top) && !up.has(top)) { up.add(top); top = (parent.get(top) as { id: string }).id; }
    walk(byId.get(top) as Row);
  } else {
    for (const r of rows) if (!parent.has(r.id)) walk(r);
    for (const r of rows) if (!seen.has(r.id)) walk(r);
  }

  const modes = new Map<string, WorkMode>(loadWorkModes().map((m) => [m.id, m]));
  const prefixes = [...modes.values()].map((m) => m.promptPrefix ?? '');
  const lastTurn = db.prepare("SELECT data FROM run_event WHERE run_id = ? AND kind = 'turn' ORDER BY seq DESC LIMIT 1");
  const kept = order.slice(0, max);
  const nodes: MapNode[] = kept.map((r) => {
    let context: MapNode['context'] = null;
    try { const d = JSON.parse((lastTurn.get(r.id) as { data?: string } | undefined)?.data ?? 'null') as { context?: unknown } | null; if (d && typeof d.context === 'number' && d.context > 0) context = { used: d.context, limit: HANDOFF_AT }; } catch { /* a bad row reads as not measured */ }
    const m = r.mode ? modes.get(r.mode) : undefined;
    const taught = m ? { rules: [...(m.rules ?? [])], skills: [...m.skills], ...(m.skillsIfLinked ? { skillsIfLinked: [...m.skillsIfLinked] } : {}) } : undefined;
    return {
      id: `run:${r.id}`, kind: rootIds.has(r.id) ? 'orchestrator' : 'run', label: r.agent === 'codex' ? 'Codex' : r.agent === 'claude' ? 'Claude' : r.agent,
      agent: r.agent, ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), status: statusOf(r), goal: goalOf(r.prompt, prefixes),
      why: rootIds.has(r.id) ? 'started by you' : (reason.get(r.id) as { reason: string }).reason, ...(r.branch ? { branch: r.branch } : {}),
      context, costUsd: r.costUsd, messageable: r.endedAt != null && !!r.sid && r.mode !== REVIEWER_MODE, runId: r.id, ...(taught ? { taught } : {}),
    };
  });
  const have = new Set(kept.map((r) => r.id));
  const edges: MapEdge[] = [];
  for (const r of kept) { const e = reason.get(r.id); if (e && have.has(e.from)) edges.push({ from: `run:${e.from}`, to: `run:${r.id}`, reason: e.reason }); }
  return { nodes, edges, truncated: order.length - kept.length };
}

// ---- native sub-agents and background shells: read from the stored events of one run -----------------------------------------------------------

const MAX_NATIVE = 200;
const one = (v: unknown, n: number): string => { const t = redact(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const rec = (d: unknown): Record<string, unknown> | undefined => (d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined);
const SHELL_ID = /\bID[:\s]+([A-Za-z0-9_-]{2,60})/i;

/**
 * Sub-agents (a `Task` or `Agent` tool call, finished by the tool result with the same id) and background shells (a `Bash` call with `run_in_background`) of ONE run, as map nodes
 * hanging under that run (or under the sub-agent that started them, by `parent`). Never measured: a sub-agent's own context (`context: null`). The event shapes were not seen on
 * a signed-in CLI (ADR-027); the stored `tool` events carry the tool input, which is all this reads. Bounded: 200 nodes, clipped and redacted strings.
 */
export function extractNative(events: { seq: number; ts: string; kind: string; data: unknown }[], runId: string, ended: boolean): { nodes: MapNode[]; edges: MapEdge[]; truncated: number } {
  type Call = { id: string; name: string; input: Record<string, unknown>; parent?: string };
  const calls: Call[] = [], results = new Map<string, { body: string; isError: boolean }>();
  for (const e of events) {
    const d = rec(e?.data);
    if (!d) continue;
    if (e.kind === 'tool' && typeof d['id'] === 'string' && d['id'] && typeof d['name'] === 'string') calls.push({ id: d['id'], name: d['name'], input: rec(d['input']) ?? {}, ...(typeof d['parent'] === 'string' ? { parent: d['parent'] } : {}) });
    else if (e.kind === 'tool_result' && typeof d['id'] === 'string' && d['id'] && !results.has(d['id'])) results.set(d['id'], { body: typeof d['body'] === 'string' ? d['body'] : '', isError: d['isError'] === true });
  }
  const inside = new Map<string, number>(), killed = new Set<string>(), reads = new Map<string, number>();
  for (const c of calls) {
    if (c.parent) inside.set(c.parent, (inside.get(c.parent) ?? 0) + 1);
    if (c.name === 'KillShell') { const id = c.input['shell_id']; if (typeof id === 'string') killed.add(id); }
    if (c.name === 'BashOutput') { const id = c.input['bash_id'] ?? c.input['shell_id']; if (typeof id === 'string') reads.set(id, (reads.get(id) ?? 0) + 1); }
  }
  const cands = calls.filter((c) => c.name === 'Task' || c.name === 'Agent' || (c.name === 'Bash' && c.input['run_in_background'] === true));
  const nodes: MapNode[] = [], edges: MapEdge[] = [], subIds = new Set(cands.filter((c) => c.name !== 'Bash').map((c) => c.id));
  for (const c of cands.slice(0, MAX_NATIVE)) {
    const res = results.get(c.id), from = c.parent && subIds.has(c.parent) ? `sub:${runId}:${c.parent}` : `run:${runId}`;
    if (c.name === 'Bash') {
      const sid = SHELL_ID.exec(res?.body ?? '')?.[1];
      const n = sid ? reads.get(sid) ?? 0 : 0;
      nodes.push({ id: `bg:${runId}:${c.id}`, kind: 'background', label: 'Background shell', status: sid && killed.has(sid) ? 'stopped' : ended ? 'unfinished' : 'running', goal: one(c.input['command'], GOAL_MAX), why: 'background shell', context: null, messageable: false, detail: `read ${n} ${n === 1 ? 'time' : 'times'}${sid ? ` (shell ${one(sid, 40)})` : ''}` });
      edges.push({ from, to: `bg:${runId}:${c.id}`, reason: 'background shell' });
      continue;
    }
    const type = one(c.input['subagent_type'], 60), model = one(c.input['model'], 100), n = inside.get(c.id) ?? 0;
    nodes.push({
      id: `sub:${runId}:${c.id}`, kind: 'subagent', label: one(c.input['description'], 120) || type || 'sub-agent', ...(model ? { model } : {}),
      status: res ? (res.isError ? 'failed' : 'done') : ended ? 'unfinished' : 'running', goal: one(c.input['prompt'], GOAL_MAX) || one(c.input['description'], GOAL_MAX),
      why: type ? `native sub-agent: ${type}` : 'native sub-agent', context: null, messageable: false,
      detail: `${n} tool ${n === 1 ? 'call' : 'calls'} inside${res ? `. Result: ${one(res.body, 300)}` : ''}`,
    });
    edges.push({ from, to: `sub:${runId}:${c.id}`, reason: type ? `native sub-agent: ${type}` : 'native sub-agent' });
  }
  return { nodes, edges, truncated: Math.max(0, cands.length - MAX_NATIVE) };
}

const HARD_MAX = 1000;
/** `buildMap` plus the native sub-agents and background shells found in the stored events of each run on it (the events of a run are read once, tool calls and results only). */
export function buildFullMap(db: Db, home: string, o: { projectId: number; root?: string; max?: number }): ProjectMap {
  const base = buildMap(db, home, o);
  const nodes = [...base.nodes], edges = [...base.edges];
  let truncated = base.truncated;
  const q = db.prepare("SELECT seq, ts, kind, data FROM run_event WHERE run_id = ? AND kind IN ('tool', 'tool_result') ORDER BY seq LIMIT 20000");
  for (const n of base.nodes) {
    if (!n.runId) continue;
    const rows = (q.all(n.runId) as unknown as { seq: number; ts: string; kind: string; data: string }[]).map((r) => {
      let data: unknown = null;
      try { data = JSON.parse(r.data); } catch { /* a bad row is ignored */ }
      return { seq: r.seq, ts: r.ts, kind: r.kind, data };
    });
    if (!rows.length) continue;
    const nat = extractNative(rows, n.runId, n.status !== 'running');
    truncated += nat.truncated;
    const added = new Set<string>();
    for (const x of nat.nodes) { if (nodes.length < HARD_MAX) { nodes.push(x); added.add(x.id); } else truncated++; }
    for (const e of nat.edges) if (added.has(e.to)) edges.push(e);
  }
  return { nodes, edges, truncated };
}
