import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { MAX_BODY, type AgentAdapter, type HubEvent } from './types.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
/** Feed every line of a fixture through the adapter, like process.ts does (JSON per line). */
const feed = (a: AgentAdapter, name: string): HubEvent[] =>
  readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => a.parse(JSON.parse(l)));
const of = <K extends HubEvent['kind']>(ev: HubEvent[], kind: K): Extract<HubEvent, { kind: K }>[] => ev.filter((e): e is Extract<HubEvent, { kind: K }> => e.kind === kind);
const KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';   // built at runtime: no secret-looking literal in the repo

test('claude Edit → tool + diff with +/− line counts (unchanged edges are not counted)', () => {
  const ev = feed(claudeAdapter, 'claude-edit.unverified.jsonl');
  const tool = of(ev, 'tool')[0]!;
  assert.deepEqual([tool.id, tool.name], ['toolu_edit1', 'Edit']);
  assert.equal((tool.input as { file_path: string }).file_path, 'src/demo/greet.ts');
  const d = of(ev, 'diff')[0]!;
  assert.deepEqual([d.path, d.added, d.removed], ['src/demo/greet.ts', 3, 2]);
  assert.match(d.hunks, /^@@ /);
  assert.match(d.hunks, /^\+const c = 4;$/m);
  assert.match(d.hunks, /^-const b = 2;$/m);
  assert.ok(ev.findIndex((e) => e.kind === 'tool') < ev.findIndex((e) => e.kind === 'diff'), 'tool comes first');
});

test('claude MultiEdit → one diff summing every edit', () => {
  const d = of(feed(claudeAdapter, 'claude-edit.unverified.jsonl'), 'diff')[1]!;
  assert.deepEqual([d.path, d.added, d.removed], ['src/demo/util.ts', 1, 2]);
  assert.equal(d.hunks.split('\n').filter((l) => l.startsWith('@@')).length, 2);
});

test('claude TodoWrite → todo with states pending/active/done', () => {
  const t = of(feed(claudeAdapter, 'claude-todo.unverified.jsonl'), 'todo')[0]!;
  assert.deepEqual(t.items, [{ text: 'Write the parser', state: 'done' }, { text: 'Add tests', state: 'active' }, { text: 'Update docs', state: 'pending' }]);
});

test('claude thinking block → thinking with tokens = ceil(chars/4); an empty one produces nothing', () => {
  const ev = feed(claudeAdapter, 'claude-thinking.unverified.jsonl');
  const t = of(ev, 'thinking');
  assert.equal(t.length, 1);
  assert.equal(t[0]!.text, 'Plan: read the file, then change one line and run the tests.');
  assert.equal(t[0]!.tokens, Math.ceil(t[0]!.text.length / 4));
});

test('claude tool_use id pairs with tool_result tool_use_id; body, lines, error flag and array content', () => {
  const bash = feed(claudeAdapter, 'claude-bash.unverified.jsonl');
  const [tool] = of(bash, 'tool'), [res] = of(bash, 'tool_result');
  assert.equal(tool!.id, 'toolu_bash1'); assert.equal(res!.id, 'toolu_bash1');
  assert.deepEqual([res!.body, res!.lines, res!.truncated], ['line one\nline two\nline three', 3, false]);
  assert.equal(tool!.summary, 'npm test');
  const read = of(feed(claudeAdapter, 'claude-read.unverified.jsonl'), 'tool_result')[0]!;
  assert.equal(read.id, 'toolu_read1'); assert.equal(read.lines, 2);
  const err = feed(claudeAdapter, 'claude-error.unverified.jsonl');
  assert.equal(of(err, 'tool_result')[0]!.isError, true);
  assert.equal(of(err, 'tool_result')[0]!.id, of(err, 'tool')[0]!.id);
});

test('claude result.duration_ms → usage.ms', () => {
  const u = of(feed(claudeAdapter, 'claude-edit.unverified.jsonl'), 'usage')[0]!;
  assert.equal(u.ms, 4321);
});

test('claude stream_event text deltas → partial; other deltas, hook lines and message_start produce nothing', () => {
  const ev = feed(claudeAdapter, 'claude-partial.unverified.jsonl');
  assert.deepEqual(ev.map((e) => e.kind), ['partial', 'partial', 'text']);
  assert.deepEqual(of(ev, 'partial').map((e) => e.text), ['Hel', 'lo ']);
});

test('a 50 MB tool output is cut to MAX_BODY after redaction; real line count; secrets never survive the cut', () => {
  const head = `first ${KEY}\n`;
  const edge = 'y'.repeat(MAX_BODY - head.length - 12);              // the second key sits right at the MAX_BODY boundary (before redaction)
  const big = head + edge + ' ' + KEY + '\n' + 'abcdefghi\n'.repeat(5_242_880);   // ~50 MiB
  const lines = big.split('\n').length - 1;
  assert.ok(big.length > 50_000_000);
  const line = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } };
  const [r] = claudeAdapter.parse(line) as Extract<HubEvent, { kind: 'tool_result' }>[];
  assert.equal(r!.body.length, MAX_BODY);
  assert.equal(r!.truncated, true);
  assert.equal(r!.lines, lines);
  assert.ok(r!.body.startsWith('first [REDACTED:api-key]'));
  assert.ok(!/sk-A1b2/.test(r!.body), 'no key material, not even a prefix cut by the limit');
  assert.ok(JSON.stringify(r).length < MAX_BODY + 2000, 'what is persisted is bounded');
  const cx = codexAdapter.parse({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'x', aggregated_output: big, exit_code: 0 } }).find((e) => e.kind === 'tool_result') as Extract<HubEvent, { kind: 'tool_result' }>;
  assert.deepEqual([cx.body.length, cx.truncated, cx.lines], [MAX_BODY, true, lines]);
});

test('tool input is redacted deeply and every string is capped; summary stays redacted too', () => {
  const input = { command: `curl -H "Authorization: Bearer ${'Z'.repeat(30)}" ${KEY}`, nested: { list: [{ token: KEY }, `password=${'q'.repeat(12)}`], n: 5, ok: true }, big: 'x'.repeat(MAX_BODY * 3) };
  const [t] = claudeAdapter.parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input }] } }) as Extract<HubEvent, { kind: 'tool' }>[];
  const s = JSON.stringify(t);
  assert.ok(!s.includes(KEY) && !s.includes('ZZZZZZZZZZ') && !s.includes('qqqqqqqq'), 'nothing secret stored');
  assert.match(s, /REDACTED/);
  assert.equal((t!.input['big'] as string).length, MAX_BODY);
  assert.equal(((t!.input['nested'] as { n: number }).n), 5);
  const cx = codexAdapter.parse({ type: 'item.completed', item: { id: 'c2', type: 'mcp_tool_call', server: 's', tool: 'x', arguments: { k: KEY } } })[0] as Extract<HubEvent, { kind: 'tool' }>;
  assert.ok(!JSON.stringify(cx).includes(KEY));
});

test('text, thinking and partial are redacted then capped', () => {
  const text = (KEY + ' ').repeat(10) + 'z'.repeat(MAX_BODY * 2);
  const [t] = claudeAdapter.parse({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as Extract<HubEvent, { kind: 'text' }>[];
  assert.equal(t!.text.length, MAX_BODY); assert.ok(!t!.text.includes(KEY));
  const [th] = claudeAdapter.parse({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } }) as Extract<HubEvent, { kind: 'thinking' }>[];
  assert.equal(th!.text.length, MAX_BODY); assert.equal(th!.tokens, Math.ceil(text.length / 4)); assert.ok(!th!.text.includes(KEY));
  const [p] = claudeAdapter.parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `k ${KEY}` } } }) as Extract<HubEvent, { kind: 'partial' }>[];
  assert.ok(!p!.text.includes(KEY));
});

test('codex command_execution → tool + tool_result sharing the item id; exit code marks an error', () => {
  const ev = feed(codexAdapter, 'codex-command.unverified.jsonl');
  assert.deepEqual(ev.map((e) => e.kind), ['session', 'tool', 'tool_result', 'tool', 'tool_result']);
  const [t1, t2] = of(ev, 'tool'), [r1, r2] = of(ev, 'tool_result');
  assert.deepEqual([t1!.id, r1!.id, t1!.name, t1!.summary, t1!.input], ['item_1', 'item_1', 'shell', 'npm test', { command: 'npm test' }]);
  assert.deepEqual([r1!.body, r1!.lines, r1!.truncated, r1!.isError], ['ok 1\nok 2', 2, false, undefined]);
  assert.deepEqual([t2!.id, r2!.id, r2!.isError], ['item_2', 'item_2', true]);
});

test('codex file_change → tool + one diff per changed file (counts unknown: 0, hunks empty)', () => {
  const ev = feed(codexAdapter, 'codex-filechange.unverified.jsonl');
  assert.deepEqual(ev.map((e) => e.kind), ['tool', 'diff', 'diff']);
  assert.deepEqual(of(ev, 'diff').map((d) => [d.path, d.added, d.removed, d.hunks]), [['src/demo/a.ts', 0, 0, ''], ['src/demo/b.ts', 0, 0, '']]);
  assert.match(of(ev, 'tool')[0]!.summary, /update src\/demo\/a\.ts, add src\/demo\/b\.ts/);
});

test('codex reasoning → thinking; todo_list → todo', () => {
  const ev = feed(codexAdapter, 'codex-reasoning-todo.unverified.jsonl');
  const t = of(ev, 'thinking')[0]!;
  assert.deepEqual([t.text, t.tokens], ['Check the config first, then edit.', Math.ceil(t.text.length / 4)]);
  assert.deepEqual(of(ev, 'todo')[0]!.items, [{ text: 'Read config', state: 'done' }, { text: 'Edit config', state: 'pending' }]);
});

test('unknown event types become { kind: unknown, type } for both agents, and never throw', () => {
  for (const a of [claudeAdapter, codexAdapter]) {
    assert.deepEqual(a.parse({ type: 'foo.bar', x: 1 }), [{ kind: 'unknown', type: 'foo.bar' }]);
    assert.deepEqual(a.parse({ x: 1 }).map((e) => e.kind), ['unknown']);
    for (const junk of [null, undefined, 42, 'text', true, [], [1, 2], '{"type":"assistant","mess', { type: 5 }, { type: 'assistant', message: 'oops' }, { type: 'assistant', message: { content: [null, 3, { type: 'tool_use' }] } }, { type: 'item.completed', item: 7 }, { type: 'user', message: { content: 'plain' } }]) {
      assert.doesNotThrow(() => a.parse(junk), JSON.stringify(junk));
    }
  }
  const [u] = codexAdapter.parse({ type: 'item.completed', item: { type: 'brand_new_item' } });
  assert.deepEqual(u, { kind: 'unknown', type: 'item.brand_new_item' });
});

test('known but ignorable lines still produce no event', () => {
  assert.deepEqual(claudeAdapter.parse({ type: 'system', subtype: 'hook_started', hook_id: 'x' }), []);
  assert.deepEqual(claudeAdapter.parse({ type: 'system', subtype: 'hook_response' }), []);
  assert.deepEqual(claudeAdapter.parse({ type: 'stream_event', event: { type: 'message_stop' } }), []);
  assert.deepEqual(codexAdapter.parse({ type: 'turn.started' }), []);
  assert.deepEqual(codexAdapter.parse({ type: 'item.started', item: { id: 'i', type: 'command_execution', command: 'ls' } }), []);
  assert.deepEqual(claudeAdapter.parse({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }), [{ kind: 'session', nativeId: 's1', model: 'm' }]);
});
