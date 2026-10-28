import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The pure layout of the orchestrator map (web/js/map-model.js): no DOM, so it is tested here like the other panel models.
const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'js');
const M = await import(pathToFileURL(join(web, 'map-model.js')).href) as {
  layout: (m: any) => { nodes: any[]; edges: any[]; width: number; height: number };
  sizeOf: (kind: string) => { w: number; h: number };
  contextPct: (c: unknown) => number | null; reasonLabel: (r: unknown) => string; statusTone: (s: string) => string; kindLabel: (k: string) => string; changedToDone: (prev: Record<string, string>, nodes: any[]) => string[];
};
const n = (id: string, kind = 'run', status = 'done'): any => ({ id, kind, label: id, status, goal: 'g', why: 'w', messageable: false, context: null });
const e = (from: string, to: string): any => ({ from, to, reason: 'r' });
const overlap = (a: any, b: any): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('an empty map has no size; one node sits at the padding; the layout is deterministic', () => {
  assert.deepEqual(M.layout({ nodes: [], edges: [], truncated: 0 }), { nodes: [], edges: [], width: 0, height: 0 });
  const one = M.layout({ nodes: [n('a', 'orchestrator')], edges: [], truncated: 0 });
  assert.equal(one.nodes.length, 1); assert.ok(one.width >= one.nodes[0].w && one.height >= one.nodes[0].h);
  const map = { nodes: [n('r', 'orchestrator'), n('a'), n('b'), n('c')], edges: [e('r', 'a'), e('r', 'b'), e('a', 'c')], truncated: 0 };
  assert.deepEqual(M.layout(map), M.layout(JSON.parse(JSON.stringify(map))));
});

test('a parent is above its children and centred over them; siblings keep the input order, left to right; nothing overlaps', () => {
  const l = M.layout({ nodes: [n('r', 'orchestrator'), n('a'), n('b'), n('c')], edges: [e('r', 'a'), e('r', 'b'), e('a', 'c')], truncated: 0 });
  const by = Object.fromEntries(l.nodes.map((x) => [x.id, x]));
  assert.ok(by['r'].y < by['a'].y && by['a'].y < by['c'].y && by['a'].y === by['b'].y);
  assert.ok(by['a'].x < by['b'].x, 'input order');
  const kids = [by['a'], by['b']], mid = (Math.min(...kids.map((k: any) => k.x)) + Math.max(...kids.map((k: any) => k.x + k.w))) / 2;
  assert.ok(Math.abs(by['r'].x + by['r'].w / 2 - mid) < 1, 'centred');
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) assert.ok(!overlap(l.nodes[i], l.nodes[j]), `${l.nodes[i].id} / ${l.nodes[j].id}`);
});

test('an edge leaves the bottom centre of the parent and enters the top centre of the child; the label sits between', () => {
  const l = M.layout({ nodes: [n('r', 'orchestrator'), n('a')], edges: [e('r', 'a')], truncated: 0 });
  const [p, c] = [l.nodes[0], l.nodes[1]], ed = l.edges[0];
  assert.match(ed.d, new RegExp(`^M ${p.x + p.w / 2} ${p.y + p.h} C `)); assert.match(ed.d, new RegExp(` ${c.x + c.w / 2} ${c.y}$`));
  assert.ok(ed.ly > p.y + p.h && ed.ly < c.y); assert.equal(ed.reason, 'r');
});

test('kinds have their own size: cards for runs, smaller cards for sub-agents, pills for background things; several roots sit side by side', () => {
  assert.ok(M.sizeOf('subagent').w < M.sizeOf('run').w && M.sizeOf('background').h < M.sizeOf('subagent').h && M.sizeOf('hubjob').h === M.sizeOf('background').h);
  const l = M.layout({ nodes: [n('r1', 'orchestrator'), n('r2', 'orchestrator'), n('s', 'subagent'), n('b', 'background')], edges: [e('r1', 's'), e('r1', 'b')], truncated: 0 });
  const by = Object.fromEntries(l.nodes.map((x) => [x.id, x]));
  assert.ok(by['r1'].y === by['r2'].y && by['r1'].x < by['r2'].x);
  assert.equal(by['s'].w, M.sizeOf('subagent').w);
});

test('hostile input does not hang or throw: a cycle, an edge to nothing, a duplicate id, and 200 nodes in a chain stay finite', () => {
  assert.doesNotThrow(() => M.layout({ nodes: [n('a'), n('b')], edges: [e('a', 'b'), e('b', 'a')], truncated: 0 }));
  const dup = M.layout({ nodes: [n('a'), n('a'), n('b')], edges: [e('a', 'zzz'), e('nope', 'b')], truncated: 0 });
  assert.equal(new Set(dup.nodes.map((x) => x.id)).size, dup.nodes.length);
  const chain = Array.from({ length: 200 }, (_, i) => n(`c${i}`));
  const l = M.layout({ nodes: chain, edges: chain.slice(1).map((x, i) => e(`c${i}`, x.id)), truncated: 0 });
  assert.ok(Number.isFinite(l.width) && Number.isFinite(l.height) && l.height < 200 * 400);
});

test('helpers: context percentage is clamped and null when not measured; tones and labels are total; "changedToDone" lists nodes that just finished', () => {
  assert.equal(M.contextPct(null), null); assert.equal(M.contextPct({ used: 125_000, limit: 250_000 }), 50); assert.equal(M.contextPct({ used: 900_000, limit: 250_000 }), 100); assert.equal(M.contextPct({ used: 5, limit: 0 }), null);
  for (const s of ['running', 'done', 'failed', 'stopped', 'unfinished', 'unknown', 'weird']) assert.ok(M.statusTone(s));
  for (const k of ['orchestrator', 'run', 'subagent', 'background', 'hubjob', 'mcp', 'weird']) assert.ok(M.kindLabel(k));
  assert.deepEqual(M.changedToDone({ a: 'running', b: 'running', c: 'done' }, [n('a', 'run', 'done'), n('b', 'run', 'running'), n('c', 'run', 'done'), n('d', 'run', 'done')]), ['a']);
});

test('reasonLabel: every reason the server sends has a Russian text; an unknown one is shown as it came', () => {
  for (const r of ['started by you', 'handoff: limit', 'handoff: context 250K', 'handoff', 'follow-up message', 'repair after failed verify', 'review hunter', 'review verifier', 'native sub-agent', 'background shell', 'hub background job', 'spawned for another run']) assert.ok(/[\u0400-\u04FF]/.test(M.reasonLabel(r)), r);
  assert.equal(M.reasonLabel('escalation after failed verify: stuck-review'), 'эскалация после красной проверки: stuck-review');
  assert.equal(M.reasonLabel('native sub-agent: general-purpose'), 'субагент: general-purpose');
  assert.equal(M.reasonLabel('something new'), 'something new'); assert.equal(M.reasonLabel(undefined), '');
});
