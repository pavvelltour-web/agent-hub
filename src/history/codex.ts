import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl } from '../lib/jsonl.ts';
import { redact } from '../lib/redact.ts';
import { asInput, count, resultEvent, safe, text as capText, thinkingEvent } from '../adapters/event-utils.ts';
import type { HubEvent } from '../adapters/types.ts';
import { pageEvents, type EventPage } from './events.ts';
import { norm } from '../lib/paths.ts';
import { addLimit, addMessage, addUsage, getState, resetSession, setState, tx, upsertSession, type Db } from './store.ts';
import type { SyncStats } from './claude.ts';

const MAX_TEXT = 20_000;
const clip = (s: string, n = MAX_TEXT): string => (s.length > n ? s.slice(0, n) + '…' : s);

interface Thread { id: string; rollout_path: string; cwd: string | null; title: string | null; source: string | null; created_at: number | null; updated_at: number | null }

/** Open Codex's live SQLite read-only; if the app holds it, read a copy (db + wal) instead. Never writes. */
function openCodexState(codexDir: string): { db: DatabaseSync; cleanup: () => void } | undefined {
  const p = join(codexDir, 'state_5.sqlite');
  if (!existsSync(p)) return undefined;
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    db.prepare('SELECT 1 FROM threads LIMIT 1').get();
    return { db, cleanup: () => db.close() };
  } catch {
    const tmp = mkdtempSync(join(tmpdir(), 'hub-codex-'));
    for (const ext of ['', '-wal', '-shm']) if (existsSync(p + ext)) copyFileSync(p + ext, join(tmp, 'state_5.sqlite' + ext));
    const db = new DatabaseSync(join(tmp, 'state_5.sqlite'), { readOnly: true });
    return { db, cleanup: () => db.close() };
  }
}

const INJECTED = /^(<(app-context|environment_context|permissions|collaboration_mode|skills|plugins|user_instructions|turn_aborted|subagent_notification)|# AGENTS\.md instructions|<INSTRUCTIONS>)/;

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface RolloutLine { type?: string; timestamp?: string; payload?: any }

/** Import Codex threads (state_5.sqlite) and their rollout JSONL incrementally. Records token usage and weekly limit snapshots. */
export async function syncCodex(db: Db, codexDir = join(homedir(), '.codex')): Promise<SyncStats> {
  const stats: SyncStats = { files: 0, changed: 0, sessions: 0, messages: 0 };
  const opened = openCodexState(codexDir);
  if (!opened) return stats;
  try {
    const threads = opened.db.prepare('SELECT id, rollout_path, cwd, title, source, created_at, updated_at FROM threads ORDER BY updated_at').all() as unknown as Thread[];
    const parents = new Map<string, string>();
    try { for (const e of opened.db.prepare('SELECT parent_thread_id AS p, child_thread_id AS c FROM thread_spawn_edges').all() as unknown as { p: string; c: string }[]) parents.set(e.c, e.p); } catch { /* table absent in older versions */ }

    for (const t of threads) {
      const path = norm(t.rollout_path);
      if (!existsSync(path)) continue;
      stats.files++;
      const st = statSync(path);
      const prev = getState(db, path);
      if (prev && prev.size === st.size && prev.mtimeMs === Math.floor(st.mtimeMs)) continue;
      stats.changed++;
      let offset = prev && st.size >= prev.byteOffset ? prev.byteOffset : 0;
      let ordinal = offset === 0 ? 0 : prev?.lastOrdinal ?? 0;
      const id = `codex:${t.id}`;
      if (offset === 0 && prev) resetSession(db, id);
      let model: string | null = null, effort: string | null = null, cwd: string | null = t.cwd, first: string | null = null, last: string | null = null, plan: string | null = null;
      const rows: { role: string; ts: string | null; text: string; tool?: string }[] = [];
      const usage: { ts: string | null; model: string | null; u: { uncachedIn: number; cachedIn: number; out: number; reasoning: number } }[] = [];
      const limits: { ts: string; windowMinutes: number | null; usedPercent: number | null; resetsAt: number | null; planType: string | null }[] = [];
      for await (const { obj, endByte } of readJsonl(path, offset)) {
        offset = endByte;
        const l = obj as RolloutLine;
        const p = l.payload;
        if (l.timestamp) { first ??= l.timestamp; last = l.timestamp; }
        if (!p) continue;
        if (l.type === 'session_meta' && p.cwd && !cwd) cwd = p.cwd;
        else if (l.type === 'turn_context') { model = p.model ?? model; effort = p.effort ?? p.reasoning_effort ?? effort; }
        else if (l.type === 'event_msg' && p.type === 'token_count') {
          const lu = p.info?.last_token_usage;
          if (lu) usage.push({ ts: l.timestamp ?? null, model, u: { uncachedIn: Math.max(0, count(lu.input_tokens) - count(lu.cached_input_tokens)), cachedIn: count(lu.cached_input_tokens), out: count(lu.output_tokens), reasoning: count(lu.reasoning_output_tokens) } });
          const sec = p.rate_limits?.secondary;
          if (sec && l.timestamp) limits.push({ ts: l.timestamp, windowMinutes: fin(sec.window_minutes), usedPercent: fin(sec.used_percent), resetsAt: fin(sec.resets_at), planType: p.rate_limits?.plan_type ?? plan });
          const pr = p.rate_limits?.primary;
          if (pr && l.timestamp) { plan = p.rate_limits?.plan_type ?? plan; limits.push({ ts: l.timestamp, windowMinutes: fin(pr.window_minutes), usedPercent: fin(pr.used_percent), resetsAt: fin(pr.resets_at), planType: plan }); }
        } else if (l.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
          const text = (p.content as { text?: string }[] | undefined)?.map((c) => c.text ?? '').join('\n').trim() ?? '';
          if (!text || (p.role === 'user' && INJECTED.test(text.trimStart()))) continue;
          rows.push({ role: p.role, ts: l.timestamp ?? null, text: clip(redact(text)) });
        } else if (l.type === 'response_item' && p.type === 'function_call' && p.name) {
          let arg = typeof p.arguments === 'string' ? p.arguments : '';     // never String(x): `{toString:1}` throws and would abort the sync
          try { const j = JSON.parse(arg) as Record<string, unknown>; const v = j['command'] ?? j['cmd'] ?? j['path']; if (typeof v === 'string') arg = v; else if (Array.isArray(v)) arg = v.map((x) => (typeof x === 'string' ? x : '')).join(','); else if (v != null) arg = JSON.stringify(v); } catch { /* keep raw */ }
          rows.push({ role: 'tool', ts: l.timestamp ?? null, text: clip(redact(arg), 400), tool: capText(p.name, 200) || 'unknown' });
        }
      }
      const parent = parents.get(t.id);
      const iso = (n: number | null): string | null => (n ? new Date(n > 1e12 ? n : n * 1000).toISOString() : null);
      tx(db, () => {
        upsertSession(db, { id, agent: 'codex', nativeId: t.id, cwd, parentId: parent ? `codex:${parent}` : null, title: t.title ? redact(t.title) : null, model, effort, startedAt: first ?? iso(t.created_at), endedAt: last ?? iso(t.updated_at), sourceKind: 'codex-rollout', sourcePath: path, origin: parent ? 'subagent' : t.source ?? null });
        for (const r of rows) addMessage(db, id, ordinal++, r.role, r.ts, r.text, r.tool ?? null);
        for (const u of usage) addUsage(db, id, u.ts, u.model, u.u);
        for (const lim of limits) addLimit(db, { agent: 'codex', ...lim, source: 'codex-log' });
        setState(db, path, { size: st.size, mtimeMs: Math.floor(st.mtimeMs), byteOffset: offset, lastOrdinal: ordinal });
      });
      stats.messages += rows.length;
      stats.sessions++;
    }
  } finally { opened.cleanup(); }
  return stats;
}

// ---------- rollout line -> hub events (for the session page) ----------
// Shapes: message / reasoning / function_call(+_output) / custom_tool_call(+_output) were read from real rollouts on the author's PC
// (structure only). local_shell_call, update_plan and apply_patch are written from Codex's documented items and are NOT yet confirmed here.

/** Lines that only describe the thread or repeat what a response item already says. */
const BOOKKEEPING = new Set(['session_meta', 'turn_context', 'event_msg', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata', 'compacted']);
const QUIET_ITEMS = new Set(['agent_message', 'additional_tools', 'configuration_update']);

const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).filter(Boolean).join('\n') : '');
const SHELL_WRAP = /^(bash|sh|zsh|cmd|powershell|pwsh)(\.exe)?$/i;
/** `["bash","-lc","npm test"]` becomes `npm test`; any other argv is joined. */
const commandText = (c: unknown): string => Array.isArray(c) ? (c.length >= 3 && SHELL_WRAP.test(String(c[0])) && /^(-lc|-c|\/c|-command)$/i.test(String(c[1])) ? String(c[c.length - 1]) : c.map(String).join(' ')) : typeof c === 'string' ? c : '';
const parseArgs = (a: unknown): Record<string, unknown> => {
  if (a && typeof a === 'object' && !Array.isArray(a)) return a as Record<string, unknown>;
  try { const j: unknown = JSON.parse(String(a ?? '')); return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {}; } catch { return {}; }
};
const SHELLS = new Set(['shell', 'container.exec', 'shell_command', 'local_shell', 'exec_command']);

/** `*** Update File: x` sections of an apply_patch text: one tool event plus one diff per file. */
function patchEvents(id: string, patch: string): HubEvent[] {
  const files: { path: string; kind: 'add' | 'delete' | 'update'; added: number; removed: number; body: string[] }[] = [];
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(raw);
    if (m) { files.push({ path: (m[2] as string).trim(), kind: (m[1] as string).toLowerCase() as 'add' | 'delete' | 'update', added: 0, removed: 0, body: [] }); continue; }
    const f = files.at(-1);
    if (!f || raw.startsWith('*** ')) continue;
    if (raw.startsWith('+')) f.added++; else if (raw.startsWith('-')) f.removed++;
    if (/^[+\- @]/.test(raw)) f.body.push(raw);
  }
  const changes = files.map((f) => ({ path: f.path, kind: f.kind }));
  return [
    { kind: 'tool', id, name: 'edit', summary: clip(redact(files.map((f) => `${f.kind} ${f.path}`).join(', ')), 300), input: asInput({ changes }) },
    ...files.map((f): HubEvent => ({ kind: 'diff', path: safe(f.path), added: f.added, removed: f.removed, hunks: safe(f.body.join('\n')) })),
  ];
}

/** Tool output as the CLI printed it: plain text, `{"output": "...", "metadata": {"exit_code": n}}`, or content blocks. */
function outputEvent(id: string, raw: unknown): HubEvent {
  let text = textOf(raw), bad = false;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) text = textOf((raw as { content?: unknown }).content);
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { output?: unknown; metadata?: { exit_code?: unknown } };
      if (typeof j.output === 'string') { text = j.output; bad = typeof j.metadata?.exit_code === 'number' && j.metadata.exit_code !== 0; }
    } catch { /* plain text that happens to start with a brace */ }
  }
  return resultEvent(id, text, bad);
}

function itemEvents(p: { type?: string; [k: string]: unknown }): HubEvent[] {
  const id = typeof p['call_id'] === 'string' ? p['call_id'] : typeof p['id'] === 'string' ? p['id'] : '';
  switch (p.type) {
    case 'message': {
      const text = textOf(p['content']).trim();
      if (!text) return [];
      if (p['role'] === 'assistant') return [{ kind: 'text', text: safe(text) }];
      if (p['role'] === 'user' && !INJECTED.test(text.trimStart())) return [{ kind: 'user', text: safe(text) }];
      return [];
    }
    case 'reasoning': { const t = [textOf(p['summary']), textOf(p['content'])].filter(Boolean).join('\n\n').trim(); return t ? [thinkingEvent(t)] : []; }
    case 'function_call': case 'local_shell_call': {
      const name = String(p['name'] ?? 'shell'), a = p.type === 'local_shell_call' ? parseArgs(p['action']) : parseArgs(p['arguments']);
      if (name === 'update_plan') {
        const plan = Array.isArray(a['plan']) ? (a['plan'] as { step?: unknown; status?: unknown }[]) : [];
        return [{ kind: 'tool', id, name, summary: '', input: {} }, { kind: 'todo', items: plan.filter((t) => t && typeof t === 'object').map((t) => ({ text: safe(String(t.step ?? '')), state: t.status === 'completed' ? 'done' as const : t.status === 'in_progress' ? 'active' as const : 'pending' as const })) }];
      }
      if (name === 'apply_patch' && typeof a['input'] === 'string') return patchEvents(id, a['input']);
      if (p.type === 'local_shell_call' || SHELLS.has(name)) { const cmd = commandText(a['command'] ?? a['cmd']); return [{ kind: 'tool', id, name: 'shell', summary: clip(redact(cmd), 300), input: asInput({ command: cmd }) }]; }
      const brief = String(a['command'] ?? a['cmd'] ?? a['path'] ?? a['query'] ?? a['message'] ?? a['title'] ?? '');
      return [{ kind: 'tool', id, name, summary: clip(redact(brief), 300), input: asInput(a) }];
    }
    case 'custom_tool_call': {
      const name = String(p['name'] ?? 'tool'), input = typeof p['input'] === 'string' ? p['input'] : '';
      if (name === 'apply_patch') return patchEvents(id, input);
      return [{ kind: 'tool', id, name, summary: clip(redact((input.split('\n').find((l) => l.trim()) ?? '').trim()), 300), input: asInput({ input }) }];
    }
    case 'function_call_output': case 'custom_tool_call_output': return [outputEvent(id, p['output'])];
    default:
      return QUIET_ITEMS.has(String(p.type)) ? [] : [{ kind: 'unknown', type: `response_item.${typeof p.type === 'string' ? p.type.slice(0, 60) : ''}` }];
  }
}

/** One rollout line as hub events. Unknown line types become an `unknown` event, never an exception. */
export function rolloutLineEvents(line: unknown): HubEvent[] {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return [];
  const l = line as RolloutLine;
  if (typeof l.type !== 'string') return [{ kind: 'unknown', type: '(none)' }];
  if (BOOKKEEPING.has(l.type)) return [];
  if (l.type === 'response_item') return l.payload && typeof l.payload === 'object' ? itemEvents(l.payload) : [];
  return [{ kind: 'unknown', type: l.type.slice(0, 60) }];
}

/** Events of one Codex rollout file, read from `offset` (see `pageEvents` for the position format). Read-only, streamed. */
export const readSessionEvents = (sourcePath: string, o: { offset: number; limit: number }): Promise<EventPage> => pageEvents(sourcePath, o, rolloutLineEvents);
