import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNative } from './map.ts';

// Native sub-agents and background processes, read from the stored events of ONE run. The shapes are those of the Claude stream as the adapter normalises them;
// they were never seen on a signed-in CLI here, so these tests use made-up events (ADR-027: "not verified live").
let seq = 0;
const ev = (kind: string, data: Record<string, unknown>) => ({ seq: ++seq, ts: new Date(Date.UTC(2026, 9, 28, 11, 0, seq)).toISOString(), kind, data: { kind, ...data } });
const tool = (id: string, name: string, input: Record<string, unknown>, parent?: string) => ev('tool', { id, name, summary: '', input, ...(parent ? { parent } : {}) });
const result = (id: string, body = 'ok', isError = false) => ev('tool_result', { id, summary: '', body, lines: 1, truncated: false, ...(isError ? { isError: true } : {}) });
const node = (m: ReturnType<typeof extractNative>, id: string) => m.nodes.find((n) => n.id === id)!;

test('native sub-agents: one node per Task call, finished by its result; unfinished when the run ended without one, running while it is live', () => {
  const events = [tool('t1', 'Task', { description: 'Find the bug', subagent_type: 'general-purpose', prompt: 'look in src', model: 'claude-haiku-5-5' }), tool('t2', 'Agent', { description: 'Write docs' }), tool('r1', 'Read', { file_path: 'a' }, 't1'), tool('r2', 'Read', { file_path: 'b' }, 't1'), result('t1', 'The bug is in x.ts')];
  const ended = extractNative(events, 'rA', true);
  assert.equal(node(ended, 'sub:rA:t1').status, 'done'); assert.equal(node(ended, 'sub:rA:t2').status, 'unfinished');
  assert.equal(node(ended, 'sub:rA:t1').kind, 'subagent'); assert.equal(node(ended, 'sub:rA:t1').label, 'Find the bug'); assert.equal(node(ended, 'sub:rA:t1').model, 'claude-haiku-5-5');
  assert.equal(node(ended, 'sub:rA:t1').goal, 'look in src'); assert.equal(node(ended, 'sub:rA:t1').context, null, 'not measured');
  assert.match(node(ended, 'sub:rA:t1').detail ?? '', /Вызовов инструментов внутри: 2/); assert.match(node(ended, 'sub:rA:t1').detail ?? '', /The bug is in x\.ts/);
  assert.equal(node(ended, 'sub:rA:t1').messageable, false);
  assert.equal(node(extractNative(events, 'rA', false), 'sub:rA:t2').status, 'running');
  assert.deepEqual(ended.edges.map((e) => [e.from, e.to, e.reason]), [['run:rA', 'sub:rA:t1', 'native sub-agent: general-purpose'], ['run:rA', 'sub:rA:t2', 'native sub-agent']]);
  assert.equal(extractNative([tool('t3', 'Task', { description: 'x' }), result('t3', 'boom', true)], 'rA', true).nodes[0]!.status, 'failed');
});

test('a sub-agent started inside a sub-agent hangs under its parent', () => {
  const m = extractNative([tool('a', 'Task', { description: 'outer' }), tool('b', 'Task', { description: 'inner' }, 'a'), result('b'), result('a')], 'rB', true);
  assert.deepEqual(m.edges.map((e) => [e.from, e.to]), [['run:rB', 'sub:rB:a'], ['sub:rB:a', 'sub:rB:b']]);
});

test('background shells: found by run_in_background, stopped by a KillShell naming its id, otherwise running or unfinished; the command is redacted', () => {
  const events = [tool('b1', 'Bash', { command: 'npm run dev --token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', run_in_background: true }), result('b1', 'Command running in background with ID: bash_1'),
    tool('b2', 'Bash', { command: 'sleep 99', run_in_background: true }), result('b2', 'Command running in background with ID: bash_2'),
    tool('x', 'Bash', { command: 'ls' }), tool('k', 'KillShell', { shell_id: 'bash_2' }), tool('o', 'BashOutput', { bash_id: 'bash_1' }), tool('o2', 'BashOutput', { bash_id: 'bash_1' })];
  const m = extractNative(events, 'rC', false);
  const n1 = node(m, 'bg:rC:b1'), n2 = node(m, 'bg:rC:b2');
  assert.deepEqual([n1.kind, n1.status, n2.status], ['background', 'running', 'stopped']);
  assert.ok(!n1.goal.includes('sk-ant') && n1.goal.startsWith('npm run dev')); assert.match(n1.detail ?? '', /Вывод читали раз: 2/);
  assert.equal(m.nodes.length, 2, 'a plain Bash call is not a node');
  assert.equal(node(extractNative(events, 'rC', true), 'bg:rC:b1').status, 'unfinished');
  assert.deepEqual(m.edges.map((e) => e.reason), ['background shell', 'background shell']);
});

test('hostile and oversized input: strings are clipped and redacted, nodes are capped at 200, a call without an id is skipped, junk events are ignored', () => {
  const many = Array.from({ length: 260 }, (_, i) => tool(`m${i}`, 'Task', { description: 'd'.repeat(600) + ' sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }));
  const m = extractNative([...many, tool('', 'Task', { description: 'no id' }), ev('tool', { name: 'Task' }), { seq: 9, ts: 'x', kind: 'tool', data: null }, { seq: 10, ts: 'x', kind: 'tool', data: 'text' }] as never, 'rD', true);
  assert.equal(m.nodes.length, 200); assert.equal(m.truncated, 60);
  assert.ok(m.nodes.every((n) => n.label.length <= 121 && !n.label.includes('sk-ant') && n.goal.length <= 201));
});
