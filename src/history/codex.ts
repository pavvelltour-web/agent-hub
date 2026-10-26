import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl } from '../lib/jsonl.ts';
import { redact } from '../lib/redact.ts';
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
          if (lu) usage.push({ ts: l.timestamp ?? null, model, u: { uncachedIn: Math.max(0, (lu.input_tokens ?? 0) - (lu.cached_input_tokens ?? 0)), cachedIn: lu.cached_input_tokens ?? 0, out: lu.output_tokens ?? 0, reasoning: lu.reasoning_output_tokens ?? 0 } });
          const pr = p.rate_limits?.primary;
          if (pr && l.timestamp) { plan = p.rate_limits?.plan_type ?? plan; limits.push({ ts: l.timestamp, windowMinutes: pr.window_minutes ?? null, usedPercent: pr.used_percent ?? null, resetsAt: pr.resets_at ?? null, planType: plan }); }
        } else if (l.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
          const text = (p.content as { text?: string }[] | undefined)?.map((c) => c.text ?? '').join('\n').trim() ?? '';
          if (!text || (p.role === 'user' && INJECTED.test(text.trimStart()))) continue;
          rows.push({ role: p.role, ts: l.timestamp ?? null, text: clip(redact(text)) });
        } else if (l.type === 'response_item' && p.type === 'function_call' && p.name) {
          let arg = String(p.arguments ?? '');
          try { const j = JSON.parse(arg) as Record<string, unknown>; arg = String(j['command'] ?? j['cmd'] ?? j['path'] ?? arg); } catch { /* keep raw */ }
          rows.push({ role: 'tool', ts: l.timestamp ?? null, text: clip(redact(arg), 400), tool: p.name });
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
