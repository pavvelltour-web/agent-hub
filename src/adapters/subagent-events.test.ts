import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter } from './claude.ts';
import { sanitizeEvent } from './event-utils.ts';

// Sub-agent lines carry their parent, so the orchestrator map can attribute their calls (ADR-027).
const parentOf = (e: unknown): string | undefined => (e as { parent?: string }).parent;

test('claude: tool, tool_result and text events of a sub-agent line carry `parent`; a main-session line has none', () => {
  const inside = claudeAdapter.parse({ type: 'assistant', parent_tool_use_id: 'toolu_task1', message: { content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: 'a.ts' } }] } });
  assert.deepEqual(inside.filter((e) => e.kind === 'tool' || e.kind === 'text').map(parentOf), ['toolu_task1', 'toolu_task1']);
  const res = claudeAdapter.parse({ type: 'user', parent_tool_use_id: 'toolu_task1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'ok' }] } });
  assert.equal(parentOf(res[0]), 'toolu_task1');
  const main = claudeAdapter.parse({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Task', input: { description: 'd' } }] } });
  assert.ok(main.every((e) => !('parent' in e)), 'no parent on a main-session event');
  assert.ok(!inside.some((e) => e.kind === 'context'), 'a sub-agent call still does not count toward the session context');
});

test('sanitizeEvent keeps a plain `parent` (at most 200 characters) on tool, tool_result and text, and drops anything else', () => {
  assert.equal(parentOf(sanitizeEvent({ kind: 'tool', id: 'a', name: 'Read', summary: '', input: {}, parent: 'p1' } as never)), 'p1');
  assert.equal(parentOf(sanitizeEvent({ kind: 'tool_result', id: 'a', summary: '', body: '', lines: 0, truncated: false, parent: 'p2' } as never)), 'p2');
  assert.equal(parentOf(sanitizeEvent({ kind: 'text', text: 'x', parent: 'p3' } as never)), 'p3');
  assert.equal(parentOf(sanitizeEvent({ kind: 'text', text: 'x', parent: 7 } as never)), undefined);
  assert.equal(parentOf(sanitizeEvent({ kind: 'text', text: 'x', parent: 'q'.repeat(300) } as never)), undefined, 'too long: dropped, not cut');
  assert.equal('parent' in (sanitizeEvent({ kind: 'text', text: 'x' } as never) as object), false);
});
