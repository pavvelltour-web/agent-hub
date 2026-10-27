import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAdapter } from './claude.ts';
import { codexAdapter, parseResetTime } from './codex.ts';
import { startAgent } from './process.ts';
import type { AgentAdapter, HubEvent } from './types.ts';
import { sanitizeEvent } from './event-utils.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const withFake = (a: AgentAdapter): AgentAdapter => ({ ...a, exe: () => ({ cmd: process.execPath, prefix: [fake] }) });
const run = async (a: AgentAdapter, scenario: string, prompt = 'hello world', stopAfterMs?: number): Promise<HubEvent[]> => {
  const ev: HubEvent[] = [];
  const h = startAgent(withFake(a), { prompt, cwd: process.cwd() }, (e) => ev.push(e), { env: { ...process.env, FAKE_SCENARIO: scenario } });
  if (stopAfterMs) setTimeout(() => h.stop(), stopAfterMs);
  await h.done;
  return ev;
};

test('claude args: prompt is not an argument; permission/model/effort/resume mapped; default is auto (edit), never bypass', () => {
  const a = claudeAdapter.args({ prompt: 'SECRET PROMPT', cwd: '.', model: 'sonnet', effort: 'medium', resumeId: 'abc' });
  assert.ok(!a.includes('SECRET PROMPT'));
  assert.deepEqual(a.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode']);
  assert.equal(a[5], 'auto');
  assert.equal(a[6], '--include-partial-messages', 'live text deltas (Task 2.1)');
  assert.deepEqual(a.slice(-6),['--model', 'sonnet', '--effort', 'medium', '--resume', 'abc']);
  assert.equal(claudeAdapter.args({ prompt: '', cwd: '.', permission: 'plan' })[5], 'plan');
});

test('codex args: stdin prompt marker, sandbox mapped, effort via -c, resume keeps the mode via -c, not -s', () => {
  const a = codexAdapter.args({ prompt: 'x', cwd: '.', model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(a, ['exec', '--json', '-s', 'workspace-write', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-']);
  assert.deepEqual(codexAdapter.args({ prompt: 'x', cwd: '.', resumeId: 'T1' }), ['exec', 'resume', 'T1', '--json', '-c', 'sandbox_mode="workspace-write"', '-']);
  assert.equal(codexAdapter.args({ prompt: 'x', cwd: '.', permission: 'plan' })[3], 'read-only');
});

test('claude parse: REAL recorded not-logged-in result (this PC) → login error + done', () => {
  const real = { type: 'result', subtype: 'success', is_error: true, api_error_status: null, duration_ms: 2095, num_turns: 1, result: 'Not logged in � Please run /login', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 };
  const ev = claudeAdapter.parse(real);
  assert.ok(ev.some((e) => e.kind === 'error' && e.needsLogin));
  assert.deepEqual(ev.at(-1), { kind: 'done', ok: false });
});

test('codex parse: REAL recorded usage-limit failure (this PC) → limit with reset time; skills-budget notice is only a warning', () => {
  const real = { type: 'turn.failed', error: { message: 'You�ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 27th, 2026 12:03 PM.' } };
  const [e] = codexAdapter.parse(real) as [Extract<HubEvent, { kind: 'limit' }>];
  assert.equal(e.kind, 'limit'); assert.equal(e.reached, true);
  const d = new Date(e.resetsAt!);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 9, 27, 12, 3]);
  const w = codexAdapter.parse({ type: 'item.completed', item: { type: 'error', message: 'Exceeded skills context budget. All skill descriptions were removed and 135 additional skills were not included.' } });
  assert.equal(w[0]?.kind, 'warn');
  assert.equal(parseResetTime('no date here'), undefined);
});

test('startAgent claude-ok: normalized events, prompt arrives through stdin, exactly one done', async () => {
  const ev = await run(claudeAdapter, 'claude-ok', 'x'.repeat(50_000));
  assert.equal(ev[0]?.kind, 'session');
  const text = ev.find((e) => e.kind === 'text') as { text: string };
  assert.match(text.text, /got 50000 chars/, 'a 50k prompt would not fit a Windows command line; stdin has no limit');
  assert.deepEqual(ev.filter((e) => e.kind === 'tool').map((e: any) => e.summary), ['npm test']);
  assert.equal((ev.find((e) => e.kind === 'tool_result') as any).isError, true);
  const u = ev.find((e) => e.kind === 'usage') as any;
  assert.deepEqual([u.uncachedIn, u.cachedIn, u.out], [15, 900, 40]);
  assert.equal(ev.filter((e) => e.kind === 'done').length, 1);
  assert.deepEqual(ev.at(-1), { kind: 'done', ok: true });
});

test('startAgent codex-limit: limit event, done ok=false', async () => {
  const ev = await run(codexAdapter, 'codex-limit');
  assert.ok(ev.some((e) => e.kind === 'limit' && e.reached));
  assert.deepEqual(ev.at(-1), { kind: 'done', ok: false });
  const ok = await run(codexAdapter, 'codex-ok');
  const u = ok.find((e) => e.kind === 'usage') as any;
  assert.deepEqual([u.uncachedIn, u.cachedIn, u.reasoning], [200, 800, 20]);
});

test('stop kills the process tree; crash reports stderr; missing exe is a clean error', async () => {
  const t0 = Date.now();
  const ev = await run(claudeAdapter, 'slow', 'p', 400);
  assert.ok(Date.now() - t0 < 10_000, 'stopped long before the 60s sleep');
  assert.deepEqual(ev.at(-1), { kind: 'done', ok: false });
  const crash = await run(claudeAdapter, 'crash');
  assert.ok(crash.some((e) => e.kind === 'error' && /boom/.test(e.message)));
  const none: HubEvent[] = [];
  const h = startAgent({ ...claudeAdapter, exe: () => undefined }, { prompt: 'x', cwd: '.' }, (e) => none.push(e));
  await h.done;
  assert.deepEqual(none.map((e) => e.kind), ['error', 'done']);
});

test('a line that makes parse or the consumer throw cannot escape the stdout listener: a warn is emitted and the next lines still arrive', async () => {
  const ev: HubEvent[] = [];
  let parsed = 0, threw = false;
  const hostile: AgentAdapter = { ...withFake(claudeAdapter), parse: (o) => { if (++parsed === 1) throw new Error('parse blew up'); return claudeAdapter.parse(o); } };
  const h = startAgent(hostile, { prompt: 'x', cwd: process.cwd() }, (e) => { if (e.kind === 'tool_result' && !threw) { threw = true; throw new TypeError('consumer blew up'); } ev.push(e); },
    { env: { ...process.env, FAKE_SCENARIO: 'fixture:claude-read.unverified.jsonl+claude-bash.unverified.jsonl', FAKE_FIXTURE_DELAY: '0' } });
  await h.done;
  assert.equal(threw, true);
  const warns = ev.filter((e) => e.kind === 'warn');
  assert.equal(warns.length, 2, 'one warn per swallowed failure');
  assert.ok(warns.every((w) => w.kind === 'warn' && !/blew up/.test(w.message)), 'fixed message, no exception text');
  assert.deepEqual(ev.filter((e) => e.kind !== 'warn').map((e) => e.kind), ['tool', 'tool_result', 'done'], 'later lines are still parsed and delivered');
});

test('claude parse: per-call prompt size (input + cache writes + cache reads) becomes a context event; the run total in `result` does not; hostile numbers are ignored', () => {
  // Phase 7 (ADR-024): the context event also carries the call's split (newIn / cachedIn / out), so the size itself is compared here.
  const ctx = (usage: unknown): unknown[] => claudeAdapter.parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage } }).filter((e) => e.kind === 'context').map((e) => ({ kind: e.kind, tokens: (e as { tokens: number }).tokens }));
  assert.deepEqual(ctx({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 40 }), [{ kind: 'context', tokens: 915 }]);
  assert.deepEqual(ctx({ input_tokens: 'many', cache_read_input_tokens: -5, cache_creation_input_tokens: Infinity }), []);
  assert.deepEqual(ctx(undefined), []); assert.deepEqual(ctx([1, 2]), []);
  assert.ok(!claudeAdapter.parse({ type: 'result', is_error: false, usage: { input_tokens: 1, cache_read_input_tokens: 900000, output_tokens: 1 } }).some((e) => e.kind === 'context'), 'a whole run summed over many calls is not a context size');
});

test('N4: a subagent\'s call (parent_tool_use_id) does not count toward the parent session\'s context', () => {
  const line = (extra: object): unknown[] => claudeAdapter.parse({ type: 'assistant', ...extra, message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 900_000 } } }).filter((e) => e.kind === 'context').map((e) => ({ kind: e.kind, tokens: (e as { tokens: number }).tokens }));
  assert.deepEqual(line({ parent_tool_use_id: 'toolu_1' }), []);
  assert.deepEqual(line({ parent_tool_use_id: null }), [{ kind: 'context', tokens: 900_000 }]);
  assert.deepEqual(line({}), [{ kind: 'context', tokens: 900_000 }]);
});

test('Phase 7: the context event carries the split of the call (new input, cached input, output) and the message id; hostile fields are rebuilt by the sanitizer', () => {
  const [c] = claudeAdapter.parse({ type: 'assistant', message: { id: 'msg_01abc', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 40 } } }).filter((e) => e.kind === 'context');
  assert.deepEqual(c, { kind: 'context', tokens: 915, newIn: 15, cachedIn: 900, out: 40, mid: 'msg_01abc' });
  const [n] = claudeAdapter.parse({ type: 'assistant', message: { id: { toString: 1 }, content: [], usage: { input_tokens: 3, output_tokens: 'x' } } }).filter((e) => e.kind === 'context');
  assert.deepEqual(n, { kind: 'context', tokens: 3, newIn: 3, cachedIn: 0, out: 0 }, 'a non-string id and a non-numeric output are dropped, not stringified');
  const first = claudeAdapter.parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: { input_tokens: 3 } } });
  assert.equal(first[0]!.kind, 'context', 'the context event comes FIRST in a line: it opens the turn that the tool calls of the line belong to');
  const s = sanitizeEvent({ kind: 'context', tokens: 10.7, newIn: -1, cachedIn: Infinity, out: 'x', mid: 'k'.repeat(500) } as never) as { tokens: number; newIn: number; cachedIn: number; out: number; mid?: string };
  assert.deepEqual([s.tokens, s.newIn, s.cachedIn, s.out], [10, 0, 0, 0]); assert.ok((s.mid ?? '').length <= 120);
  const t = sanitizeEvent({ kind: 'turn', newIn: 5, cachedIn: NaN, out: 7.9, reasoning: -2, context: 1e30, mid: 'm' } as never) as Record<string, unknown>;
  assert.equal(t['kind'], 'turn'); assert.equal(t['cachedIn'], 0); assert.equal(t['out'], 7); assert.equal(t['reasoning'], undefined); assert.ok(Number.isSafeInteger(t['context']));
});
