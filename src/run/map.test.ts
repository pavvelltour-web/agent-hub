import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, projectId } from '../history/store.ts';
import { HANDOFF_AT } from '../econ/context.ts';
import { buildMap } from './map.ts';

const home = mkdtempSync(join(tmpdir(), 'hub-map-'));
const db = openDb(':memory:');
const P = projectId(db, join(home, 'proj-a')) as number, Q = projectId(db, join(home, 'proj-b')) as number;
type R = Partial<{ project: number; agent: string; model: string; prompt: string; start: string; end: string | null; outcome: string | null; sid: string | null; cost: number; handoff: string; resume: string; mode: string; parent: string; reason: string }>;
let tick = 0;
const run = (id: string, o: R = {}): void => {
  const at = o.start ?? new Date(Date.UTC(2026, 9, 28, 10, 0, tick++)).toISOString();
  db.prepare('INSERT INTO run (id, project_id, agent, model, effort, prompt, started_at, ended_at, outcome, session_native_id, cost_usd, handoff_of, resume_of, work_mode, parent_run, spawn_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, o.project ?? P, o.agent ?? 'claude', o.model ?? 'claude-sonnet-5-5', 'high', o.prompt ?? `task ${id}`, at, o.end === undefined ? at : o.end, o.outcome === undefined ? 'done' : o.outcome, o.sid === undefined ? `sess-${id}` : o.sid, o.cost ?? null, o.handoff ?? null, o.resume ?? null, o.mode ?? null, o.parent ?? null, o.reason ?? null);
};
const turn = (id: string, seq: number, context: number): void => { db.prepare('INSERT INTO run_event (run_id, seq, ts, kind, data) VALUES (?,?,?,?,?)').run(id, seq, new Date().toISOString(), 'turn', JSON.stringify({ kind: 'turn', newIn: 1, cachedIn: 2, out: 3, context })); };
const cascade = (id: string, rungs: { runId: string; role: string; repair?: boolean }[]): void => {
  mkdirSync(join(home, 'cascades'), { recursive: true });
  writeFileSync(join(home, 'cascades', `${id}.json`), JSON.stringify({ id, status: 'solved', startedAt: new Date().toISOString(), verify: ['node', 'check.js'], rungs: rungs.map((r) => ({ ...r, verifyPassed: false, agent: 'claude', model: 'claude-opus-5-5', effort: 'high' })) }));
};
const ids = (m: { nodes: { id: string }[] }): string[] => m.nodes.map((n) => n.id).sort();
const edge = (m: { edges: { from: string; to: string; reason: string }[] }, from: string, to: string) => m.edges.find((e) => e.from === `run:${from}` && e.to === `run:${to}`);

test('an empty project has an empty map; a single run is the orchestrator with its goal, model and status', () => {
  assert.deepEqual(buildMap(db, home, { projectId: Q }), { nodes: [], edges: [], truncated: 0 });
  run('rsolo', { prompt: 'make the button blue', cost: 0.5 });
  const m = buildMap(db, home, { projectId: P });
  const n = m.nodes.find((x) => x.id === 'run:rsolo')!;
  assert.equal(n.kind, 'orchestrator'); assert.equal(n.model, 'claude-sonnet-5-5'); assert.equal(n.goal, 'make the button blue'); assert.equal(n.status, 'done'); assert.equal(n.costUsd, 0.5); assert.equal(n.runId, 'rsolo');
});

test('status: no end = running; done; failed; limit and interrupted = stopped', () => {
  run('rrun', { end: null, outcome: null }); run('rfail', { outcome: 'failed' }); run('rlim', { outcome: 'limit' }); run('rint', { outcome: 'interrupted' });
  const m = buildMap(db, home, { projectId: P });
  const s = (id: string): string => m.nodes.find((x) => x.id === `run:${id}`)!.status;
  assert.deepEqual([s('rrun'), s('rfail'), s('rlim'), s('rint')], ['running', 'failed', 'stopped', 'stopped']);
});

test('handoff and resume chains: children with the reason they exist; the handoff reason says why the first run stopped', () => {
  run('h1', { outcome: 'limit' }); run('h2', { handoff: 'h1', agent: 'codex', outcome: 'context' }); run('h3', { handoff: 'h2' }); run('h4', { resume: 'h3', prompt: 'and also the footer' });
  const m = buildMap(db, home, { projectId: P, root: 'h3' });
  assert.deepEqual(ids(m), ['run:h1', 'run:h2', 'run:h3', 'run:h4'], 'the whole chain, whichever run is asked for');
  assert.equal(edge(m, 'h1', 'h2')!.reason, 'handoff: limit');
  assert.equal(edge(m, 'h2', 'h3')!.reason, 'handoff: context 250K');
  assert.equal(edge(m, 'h3', 'h4')!.reason, 'follow-up message');
  assert.equal(m.nodes.find((n) => n.id === 'run:h1')!.kind, 'orchestrator');
  assert.equal(m.nodes.find((n) => n.id === 'run:h2')!.kind, 'run');
});

test('cascade: the first rung is the orchestrator, later rungs are children with their role', () => {
  run('c1'); run('c2'); run('c3'); run('c4');
  cascade('casc1', [{ runId: 'c1', role: 'executor' }, { runId: 'c2', role: 'executor', repair: true }, { runId: 'c3', role: 'stuck-review' }, { runId: 'c4', role: 'fixer' }]);
  const m = buildMap(db, home, { projectId: P, root: 'c4' });
  assert.deepEqual(ids(m), ['run:c1', 'run:c2', 'run:c3', 'run:c4']);
  assert.equal(edge(m, 'c1', 'c2')!.reason, 'repair after failed verify');
  assert.equal(edge(m, 'c1', 'c3')!.reason, 'escalation after failed verify: stuck-review');
  assert.equal(edge(m, 'c1', 'c4')!.reason, 'escalation after failed verify: fixer');
});

test('review reviewers attach to the reviewed run with their reason; they cannot be messaged', () => {
  run('rv0'); run('rv1', { mode: 'gate-reviewer', parent: 'rv0', reason: 'review hunter', model: 'claude-opus-5-5' }); run('rv2', { mode: 'gate-reviewer', parent: 'rv0', reason: 'review verifier', agent: 'codex' });
  run('rvlost', { mode: 'gate-reviewer' });   // a reviewer run of an older version: no parent, not shown
  const m = buildMap(db, home, { projectId: P, root: 'rv0' });
  assert.equal(edge(m, 'rv0', 'rv1')!.reason, 'review hunter'); assert.equal(edge(m, 'rv0', 'rv2')!.reason, 'review verifier');
  assert.equal(m.nodes.find((n) => n.id === 'run:rv1')!.messageable, false);
  assert.ok(!buildMap(db, home, { projectId: P }).nodes.some((n) => n.id === 'run:rvlost'));
});

test('messageable: only a finished hub run with a session id that is not a reviewer', () => {
  run('m-ok'); run('m-live', { end: null, outcome: null }); run('m-nosid', { sid: null });
  const m = buildMap(db, home, { projectId: P });
  const f = (id: string): boolean => m.nodes.find((n) => n.id === `run:${id}`)!.messageable;
  assert.deepEqual([f('m-ok'), f('m-live'), f('m-nosid')], [true, false, false]);
});

test('context comes from the last turn row, null when the run has none; limit is the hub handoff size', () => {
  run('x1'); run('x2'); turn('x1', 1, 40_000); turn('x1', 2, 123_456);
  const m = buildMap(db, home, { projectId: P });
  assert.deepEqual(m.nodes.find((n) => n.id === 'run:x1')!.context, { used: 123_456, limit: HANDOFF_AT });
  assert.equal(m.nodes.find((n) => n.id === 'run:x2')!.context, null);
});

test('what the agent was taught: rules and skills of the run\'s work mode; nothing for a run without a mode', () => {
  run('t1', { mode: 'interview' }); run('t2');
  const m = buildMap(db, home, { projectId: P });
  assert.deepEqual(m.nodes.find((n) => n.id === 'run:t1')!.taught, { rules: ['interview'], skills: [], skillsIfLinked: ['grill-me'] });
  assert.equal(m.nodes.find((n) => n.id === 'run:t2')!.taught, undefined);
});

test('the goal is the user text: the mode rules block and added slash commands are not part of it, and it is clipped and redacted', () => {
  const rules = '[mode rules: chat]\nBe brief.\n[end mode rules]\n\n';
  run('g1', { prompt: `${rules}Fix the login page` });
  run('g2', { prompt: `/autopilot semi normal Build the export\n\n${rules.trimEnd()}` });
  run('g3', { prompt: 'x'.repeat(1000) + ' sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' });
  const m = buildMap(db, home, { projectId: P });
  const g = (id: string): string => m.nodes.find((n) => n.id === `run:${id}`)!.goal;
  assert.equal(g('g1'), 'Fix the login page'); assert.equal(g('g2'), 'Build the export');
  assert.ok(g('g3').length <= 201 && !g('g3').includes('sk-ant'));
});

test('a cycle in the parent links terminates and shows each run once', () => {
  run('y1', { handoff: 'y2' }); run('y2', { handoff: 'y1' });
  const m = buildMap(db, home, { projectId: P });
  assert.equal(m.nodes.filter((n) => n.id === 'run:y1' || n.id === 'run:y2').length, 2);
  assert.equal(new Set(m.nodes.map((n) => n.id)).size, m.nodes.length);
});

test('max truncates and says how many were left out; another project never appears', () => {
  run('o1', { project: Q }); run('o2', { project: Q, handoff: 'o1' });
  assert.deepEqual(ids(buildMap(db, home, { projectId: Q })), ['run:o1', 'run:o2']);
  const all = buildMap(db, home, { projectId: P });
  const cut = buildMap(db, home, { projectId: P, max: 5 });
  assert.equal(cut.nodes.length, 5); assert.equal(cut.truncated, all.nodes.length - 5);
  assert.ok(cut.edges.every((e) => cut.nodes.some((n) => n.id === e.from) && cut.nodes.some((n) => n.id === e.to)));
  assert.ok(!all.nodes.some((n) => n.id === 'run:o1'));
});
