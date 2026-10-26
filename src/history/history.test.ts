import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, listProjects, listSessions, search, getSession, usageByModel, latestLimit, projectRoot } from './store.ts';
import { syncClaude } from './claude.ts';
import { syncCodex } from './codex.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hub-hist-'));
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
writeFileSync(rolloutSub, L({ type: 'session_meta', timestamp: '2026-10-21T08:01:00Z', payload: { id: 'T2', cwd: 'C:\\Users\\u\\Desktop\\AmpliCore-worktrees\\001-x' } }) + L({ type: 'event_msg', timestamp: '2026-10-21T08:01:01Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 5 } }, rate_limits: { plan_type: 'prolite', primary: { used_percent: 71, window_minutes: 10080, resets_at: 1793091834 } } } }));
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
