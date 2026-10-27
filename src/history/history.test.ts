import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, listProjects, listSessions, search, getSession, usageByModel, latestLimit, projectRoot } from './store.ts';
import { syncClaude } from './claude.ts';
import { syncCodex } from './codex.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hub-hist-'));
const extraTmp: string[] = [tmp];
after(() => { for (const d of extraTmp) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const L = (o: unknown): string => JSON.stringify(o) + '\n';

// ----- Claude fixture -----
const claudeDir = join(tmp, '.claude');
mkdirSync(join(claudeDir, 'projects', 'C--Users-u-Desktop-AmpliCore'), { recursive: true });
const cf = join(claudeDir, 'projects', 'C--Users-u-Desktop-AmpliCore', 'sess-1.jsonl');
const cwd = 'C:\\Users\\u\\Desktop\\AmpliCore';
writeFileSync(cf,
  L({ type: 'queue-operation', operation: 'enqueue', content: 'ignored noise' }) +
  L({ type: 'user', sessionId: 'sess-1', cwd, timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: 'Почини тест на хуки, ключ sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' } }) +
  L({ type: 'user', sessionId: 'sess-1', isMeta: true, timestamp: '2026-10-20T10:00:01Z', message: { role: 'user', content: 'meta, skip' } }) +
  L({ type: 'assistant', sessionId: 'sess-1', cwd, timestamp: '2026-10-20T10:00:05Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Смотрю compilers/hooks.ts' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/core/hooks.ts' } }], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 40 } } }));

// ----- Codex fixture -----
const codexDir = join(tmp, '.codex');
mkdirSync(join(codexDir, 'sessions'), { recursive: true });
const rollout = join(codexDir, 'sessions', 'rollout-a.jsonl');
const rolloutSub = join(codexDir, 'sessions', 'rollout-b.jsonl');
writeFileSync(rollout,
  L({ type: 'session_meta', timestamp: '2026-10-21T08:00:00Z', payload: { id: 'T1', cwd: '\\\\?\\C:\\Users\\u\\Desktop\\AmpliCore' } }) +
  L({ type: 'turn_context', timestamp: '2026-10-21T08:00:01Z', payload: { model: 'gpt-6.1-sol', effort: 'high' } }) +
  L({ type: 'response_item', timestamp: '2026-10-21T08:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n...' }] } }) +
  L({ type: 'response_item', timestamp: '2026-10-21T08:00:03Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Сделай адаптер Codex' }] } }) +
  L({ type: 'response_item', timestamp: '2026-10-21T08:00:04Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"npm test"}' } }) +
  L({ type: 'response_item', timestamp: '2026-10-21T08:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Адаптер готов, тест падает.' }] } }) +
  L({ type: 'event_msg', timestamp: '2026-10-21T08:00:06Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 60, reasoning_output_tokens: 20 } }, rate_limits: { plan_type: 'prolite', primary: { used_percent: 70, window_minutes: 10080, resets_at: 1793091834 } } } }));
writeFileSync(rolloutSub, L({ type: 'session_meta', timestamp: '2026-10-21T08:01:00Z', payload: { id: 'T2', cwd: 'C:\\Users\\u\\Desktop\\AmpliCore-worktrees\\001-x' } }) + L({ type: 'event_msg', timestamp: '2026-10-21T08:01:01Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 5 } }, rate_limits: { plan_type: 'prolite', primary: { used_percent: 71, window_minutes: 10080, resets_at: 1793091834 }, secondary: { used_percent: 12, window_minutes: 300, resets_at: 1792300000 } } } }));
const st = new DatabaseSync(join(codexDir, 'state_5.sqlite'));
st.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);');
st.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('T1', `\\\\?\\${rollout}`, '\\\\?\\C:\\Users\\u\\Desktop\\AmpliCore', 'Адаптер Codex', 'vscode', 1792000000, 1792000100);
st.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('T2', rolloutSub, 'C:\\Users\\u\\Desktop\\AmpliCore-worktrees\\001-x', 'sub', '{"subagent":{}}', 1792000010, 1792000200);
st.prepare('INSERT INTO thread_spawn_edges VALUES (?,?,?)').run('T1', 'T2', 'done');
st.close();

test('both agents import into one project; secrets redacted; noise skipped', async () => {
  const db = openDb(':memory:');
  const c = await syncClaude(db, claudeDir);
  const x = await syncCodex(db, codexDir);
  assert.equal(c.changed, 1); assert.equal(x.sessions, 2);
  const projects = listProjects(db);
  assert.equal(projects.length, 1, 'AmpliCore + AmpliCore-worktrees/001-x + \\\\?\\ prefix collapse to one project');
  assert.equal(projects[0]!.slug, 'AmpliCore');
  assert.equal(projects[0]!.claude, 1); assert.equal(projects[0]!.codex, 1, 'subagent thread is not a top-level session');
  const s = getSession(db, 'claude:sess-1')!;
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant', 'tool']);
  assert.ok(s.messages[0]!.text.includes('[REDACTED'), 'secret redacted in index');
  assert.ok(!JSON.stringify(s).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
  assert.equal(s.messages[2]!.toolName, 'Read');
  const cx = getSession(db, 'codex:T1')!;
  assert.deepEqual(cx.messages.map((m) => m.role), ['user', 'tool', 'assistant']);
  assert.equal(cx.messages[0]!.text, 'Сделай адаптер Codex', 'injected AGENTS.md context skipped');
  assert.equal(cx.session.model, 'gpt-6.1-sol');
  assert.equal(listSessions(db, { parentOnly: undefined } as any).find((r) => r.id === 'codex:T2')?.parentId, 'codex:T1');
});

test('search finds Cyrillic across agents, filters by agent, quotes operators', async () => {
  const db = openDb(':memory:');
  await syncClaude(db, claudeDir); await syncCodex(db, codexDir);
  assert.deepEqual(search(db, 'хуки').map((h) => h.agent), ['claude']);
  assert.equal(search(db, 'адаптер')[0]?.agent, 'codex');
  assert.equal(search(db, 'адаптер', { agent: 'claude' }).length, 0);
  assert.doesNotThrow(() => search(db, 'a AND OR NOT ( " * :'));
  assert.deepEqual(search(db, '   '), []);
});

test('usage by model and weekly limit snapshot come from Codex logs; dedupes identical snapshots', async () => {
  const db = openDb(':memory:');
  await syncCodex(db, codexDir);
  const u = usageByModel(db);
  assert.equal(u[0]?.model, 'gpt-6.1-sol'); assert.equal(u[0]?.cachedIn, 800); assert.equal(u[0]?.uncachedIn, 200);
  const lim = latestLimit(db, 'codex')!;
  assert.equal(lim.usedPercent, 71); assert.equal(lim.windowMinutes, 10080); assert.equal(lim.planType, 'prolite');
});

test('Codex: BOTH rate-limit windows are stored side by side, told apart by their window length (not by the names primary/secondary)', async () => {
  const db = openDb(':memory:');
  await syncCodex(db, codexDir);
  const rows = db.prepare("SELECT window_minutes AS w, used_percent AS p FROM limit_snapshot WHERE agent = 'codex' AND ts = '2026-10-21T08:01:01Z' ORDER BY w").all() as unknown as { w: number; p: number }[];
  assert.deepEqual(rows.map((r) => [r.w, r.p]), [[300, 12], [10080, 71]]);
});

test('re-sync is idempotent and appended lines are picked up incrementally', async () => {
  const db = openDb(':memory:');
  await syncClaude(db, claudeDir);
  const before = getSession(db, 'claude:sess-1')!.session;
  const again = await syncClaude(db, claudeDir);
  assert.equal(again.changed, 0);
  appendFileSync(cf, L({ type: 'assistant', sessionId: 'sess-1', cwd, timestamp: '2026-10-20T10:05:00Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Готово' }], usage: { input_tokens: 1, output_tokens: 2 } } }));
  const inc = await syncClaude(db, claudeDir);
  assert.equal(inc.changed, 1); assert.equal(inc.messages, 1);
  const after = getSession(db, 'claude:sess-1')!;
  assert.equal(after.session.msgCount, before.msgCount + 1);
  assert.deepEqual(after.messages.map((m) => m.ordinal), [0, 1, 2, 3], 'ordinals continue, no duplicates');
});

test('projectRoot maps worktree folders to the main project', () => {
  assert.equal(projectRoot('C:\\a\\App-worktrees\\001-x\\src'), 'c:/a/App');
  assert.equal(projectRoot('C:/a/App/.claude/worktrees/bold-name'), 'c:/a/App');
  assert.equal(projectRoot('C:/a/App'), 'c:/a/App');
});

// ===== Task 2.3: events rendered from the source files =====
import { readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readSessionEvents as readClaudeEvents } from './claude.ts';
import { readSessionEvents as readCodexEvents } from './codex.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { MAX_BODY } from '../adapters/types.ts';
import { SLOT } from './events.ts';

const fx = (n: string): string => join(dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
type Page = Awaited<ReturnType<typeof readClaudeEvents>>;
type Reader = typeof readClaudeEvents;
const readAll = async (read: Reader, path: string, limit: number): Promise<{ events: Page['events']; pages: number }> => {
  const events: Page['events'] = []; let offset = 0, pages = 0;
  for (;;) {
    const r = await read(path, { offset, limit }); pages++;
    assert.ok(r.events.length <= limit, 'a page never exceeds the limit');
    events.push(...r.events);
    if (r.next == null) return { events, pages };
    assert.ok(r.next > offset, 'next always moves forward'); offset = r.next;
  }
};
const kinds = (es: { kind: string }[]): string[] => es.map((e) => e.kind);

test('history: a recorded Claude file gives the same event kinds as the live parser, plus the user message', async () => {
  const path = fx('claude-recorded.jsonl');
  const { events } = await readAll(readClaudeEvents, path, 1000);
  assert.deepEqual(kinds(events), ['user', 'thinking', 'text', 'tool', 'tool_result', 'tool', 'diff', 'tool_result', 'tool', 'todo', 'tool_result', 'unknown', 'text']);
  const live = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { const o = JSON.parse(l); return o.isSidechain || o.isMeta ? [] : claudeAdapter.parse(o); } catch { return []; } });
  assert.deepEqual(kinds(events).filter((k) => k !== 'user' && k !== 'unknown'), kinds(live).filter((k) => k !== 'unknown'), 'same kinds, same order as a live run');
  assert.equal((events[0]!.data as { text: string }).text, 'Исправь тест на хуки');
  const tool = events[3]!.data as { id: string }, res = events[4]!.data as { id: string; lines: number };
  assert.equal(tool.id, res.id, 'tool and its result are paired by id'); assert.equal(res.lines, 3);
  const diff = events[6]!.data as { added: number; removed: number }; assert.deepEqual([diff.added, diff.removed], [2, 1]);
  assert.equal((events[11]!.data as { type: string }).type, 'brand-new-line-type');
  const all = JSON.stringify(events);
  assert.ok(!all.includes('subagent chatter') && !all.includes('meta line'), 'sidechain and meta lines skipped');
});

test('history: a Codex rollout gives the same event kinds as the live parser', async () => {
  const path = fx('codex-rollout.unverified.jsonl');
  const { events } = await readAll(readCodexEvents, path, 1000);
  assert.deepEqual(kinds(events), ['user', 'thinking', 'text', 'tool', 'tool_result', 'tool', 'diff', 'tool_result', 'tool', 'todo', 'tool_result', 'unknown', 'unknown']);
  const all = JSON.stringify(events);
  assert.ok(!all.includes('developer text') && !all.includes('AGENTS.md'), 'developer and injected context skipped');
  const sh = events[3]!.data as { id: string; name: string; input: { command: string } };
  assert.equal(sh.name, 'shell'); assert.equal(sh.input.command, 'npm test');
  const out = events[4]!.data as { id: string; body: string; isError?: boolean };
  assert.equal(out.body, '1 failing\n'); assert.equal(out.isError, true); assert.equal(out.id, sh.id);
  const diff = events[6]!.data as { path: string; added: number; removed: number }; assert.deepEqual([diff.path, diff.added, diff.removed], ['src/a.ts', 2, 1]);
  assert.deepEqual((events[9]!.data as { items: unknown[] }).items, [{ text: 'Тесты', state: 'done' }, { text: 'Ревью', state: 'active' }, { text: 'Коммит', state: 'pending' }]);

  // The live stream of equivalent content: reasoning, message, command, file change, todo list.
  const live = [
    { type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'x' } }, { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'x' } },
    { type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'npm test', aggregated_output: 'x', exit_code: 1 } },
    { type: 'item.completed', item: { id: 'i4', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] } },
    { type: 'item.completed', item: { id: 'i5', type: 'todo_list', items: [{ text: 'x', completed: true }] } },
  ].flatMap((l) => codexAdapter.parse(l));
  // A rollout also records the patch result and the plan call (live item events carry neither), so those are set aside before comparing.
  const toolName = new Map<string, string>();
  for (const e of events) if (e.kind === 'tool') { const d = e.data as { id: string; name: string }; toolName.set(d.id, d.name); }
  const comparable = events.filter((e) => {
    if (e.kind === 'user' || e.kind === 'unknown') return false;
    const d = e.data as { id?: string; name?: string };
    if (e.kind === 'tool' && d.name === 'update_plan') return false;
    if (e.kind === 'tool_result' && ['edit', 'update_plan'].includes(toolName.get(d.id ?? '') ?? '')) return false;
    return true;
  });
  assert.deepEqual(kinds(comparable), kinds(live), 'same kinds, same order as a live run');
});

test('history: offset paging gives stable slices - pages concatenate to the one big read, no overlap or gap', async () => {
  for (const [read, name] of [[readClaudeEvents, 'claude-recorded.jsonl'], [readCodexEvents, 'codex-rollout.unverified.jsonl']] as const) {
    const whole = await readAll(read, fx(name), 10_000);
    assert.equal(whole.pages, 1);
    for (const limit of [1, 2, 3, 5]) {
      const paged = await readAll(read, fx(name), limit);
      assert.ok(paged.pages > 1, `${name} limit ${limit}: several pages`);
      assert.deepEqual(paged.events, whole.events, `${name} limit ${limit}`);
    }
    const seqs = whole.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'seq is unique and increasing');
  }
});

test('history: a missing source file means the conversation file was moved; a directory is refused', async () => {
  const gone = join(tmp, 'nope', 'gone.jsonl');
  assert.deepEqual(await readClaudeEvents(gone, { offset: 0, limit: 10 }), { events: [], next: null, moved: true });
  assert.deepEqual(await readCodexEvents(gone, { offset: 0, limit: 10 }), { events: [], next: null, moved: true });
  await assert.rejects(readClaudeEvents(tmp, { offset: 0, limit: 10 }), /not a regular file/);
  await assert.rejects(readCodexEvents(tmp, { offset: 0, limit: 10 }), /not a regular file/);
});

test('history: a Cyrillic path with spaces works', async () => {
  const dir = join(tmp, 'Проект с пробелами', 'сессии'); mkdirSync(dir, { recursive: true });
  const p = join(dir, 'разговор 1.jsonl'); copyFileSync(fx('claude-recorded.jsonl'), p);
  assert.equal((await readClaudeEvents(p, { offset: 0, limit: 5 })).events.length, 5);
});

test('history: the file is streamed - a small page of a 30000-line file stops after a few lines, and a 50 MB tool result is capped', async () => {
  const many = join(tmp, 'many.jsonl');
  const line = L({ type: 'assistant', timestamp: '2026-10-20T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'строка '.repeat(20) }] } });
  writeFileSync(many, line.repeat(30_000));
  const r = await readClaudeEvents(many, { offset: 0, limit: 3 });
  assert.equal(r.events.length, 3);
  assert.equal(r.next, 3 * Buffer.byteLength(line) * SLOT, 'next = byte offset right after the 3rd line (times SLOT)');
  const r2 = await readClaudeEvents(many, { offset: r.next!, limit: 3 });
  assert.ok(r2.events[0]!.seq > r.events[2]!.seq, 'seq keeps growing across pages');

  const big = join(tmp, 'huge.jsonl');
  writeFileSync(big, L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'Bash', input: { command: 'cat big' } }] } }) +
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'h1', content: 'x'.repeat(50 * 1024 * 1024) }] } }));
  const h = await readClaudeEvents(big, { offset: 0, limit: 10 });
  const res = h.events[1]!.data as { body: string; truncated: boolean };
  assert.ok(res.body.length <= MAX_BODY); assert.equal(res.truncated, true);
});

test('history: text from the file is redacted; bad offsets and limits are harmless', async () => {
  const p = join(tmp, 'secret.jsonl');
  writeFileSync(p, L({ type: 'user', message: { role: 'user', content: 'ключ sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 вот' } }) + L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
  const r = await readClaudeEvents(p, { offset: 0, limit: 10 });
  assert.ok(!JSON.stringify(r.events).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
  await assert.doesNotReject(readClaudeEvents(p, { offset: 7, limit: 10 }));
  assert.deepEqual(await readClaudeEvents(p, { offset: 10_000_000, limit: 10 }), { events: [], next: null });
  assert.equal((await readClaudeEvents(p, { offset: -5, limit: 0 })).events.length, 1, 'bad numbers are clamped (limit >= 1)');
});

test('history: Codex exec_command (cmd argument) is shown as a shell command', async () => {
  const { rolloutLineEvents } = await import('./codex.ts');
  const ev = rolloutLineEvents({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c9', arguments: JSON.stringify({ cmd: 'git status', workdir: 'C:/proj' }) } });
  assert.deepEqual(ev.map((e) => e.kind), ['tool']);
  const t = ev[0] as unknown as { name: string; input: { command: string } };
  assert.equal(t.name, 'shell'); assert.equal(t.input.command, 'git status');
});

test('history pager: a tool line with an object name / numeric id yields safe strings', async () => {
  const d = mkdtempSync(join(tmpdir(), 'hub-hist-')); extraTmp.push(d);
  const f = join(d, 's.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 123, name: { innerHTML: '<a href=x>x</a>' }, input: {} }] } }) + '\n');
  const r = await readClaudeEvents(f, { offset: 0, limit: 10 });
  const t = r.events.find((e) => e.kind === 'tool')?.data as { name: unknown; id: unknown };
  assert.equal(t.name, 'unknown'); assert.equal(typeof t.id, 'string');
});

test('index sync: an object tool name, object arguments/input or object token counts cannot abort the sync', async () => {
  const X = { toString: 1 };
  const t2 = mkdtempSync(join(tmpdir(), 'hub-hist-bad-')); extraTmp.push(t2);
  const cd = join(t2, '.claude'); mkdirSync(join(cd, 'projects', 'p'), { recursive: true });
  writeFileSync(join(cd, 'projects', 'p', 'bad-1.jsonl'),
    L({ type: 'user', sessionId: 'bad-1', cwd, timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: 'hello' } }) +
    L({ type: 'assistant', sessionId: 'bad-1', cwd, timestamp: '2026-10-20T10:00:05Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: X, input: { command: X } }], usage: { input_tokens: X, cache_read_input_tokens: '9', output_tokens: X } } }) +
    L({ type: 'assistant', sessionId: 'bad-1', cwd, timestamp: '2026-10-20T10:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'still here' }] } }));
  const db = openDb(':memory:');
  const c = await syncClaude(db, cd);
  assert.equal(c.changed, 1);
  const s = getSession(db, 'claude:bad-1')!;
  assert.ok(s.messages.some((m) => m.text === 'still here'));
  assert.ok(s.messages.filter((m) => m.role === 'tool').every((m) => typeof m.toolName === 'string'));

  const xd = join(t2, '.codex'); mkdirSync(join(xd, 'sessions'), { recursive: true });
  const ro = join(xd, 'sessions', 'rollout-bad.jsonl');
  writeFileSync(ro,
    L({ type: 'response_item', timestamp: '2026-10-21T08:00:04Z', payload: { type: 'function_call', name: X, arguments: X } }) +
    L({ type: 'event_msg', timestamp: '2026-10-21T08:00:06Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: X, cached_input_tokens: '1', output_tokens: X } } } }) +
    L({ type: 'response_item', timestamp: '2026-10-21T08:00:05Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex still here' }] } }));
  const sdb = new DatabaseSync(join(xd, 'state_5.sqlite'));
  sdb.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, created_at INTEGER, updated_at INTEGER);');
  sdb.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('B1', ro, cwd, 'bad', 'cli', 1792000000, 1792000100);
  sdb.close();
  const x = await syncCodex(db, xd);
  assert.equal(x.sessions, 1);
  const cs = getSession(db, 'codex:B1')!;
  assert.ok(cs.messages.some((m) => m.text === 'codex still here'));
  assert.ok(cs.messages.filter((m) => m.role === 'tool').every((m) => typeof m.toolName === 'string'));
});
